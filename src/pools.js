// Selection pools: shared across render sizes, rotated in a single place, refreshed
// single-flight without ever discarding usable photos.
import { objectKey } from './params.js';

const rand = () => Math.random().toString(36).slice(2, 8);

export class PoolManager {
  constructor({ store, cfg, discover, onUse, blobs, snapshots, now = () => Date.now() }) {
    Object.assign(this, { store, cfg, discover, onUse, blobs, snapshots, now });
    this.pools = new Map();
    this.loading = new Map();
    this.flights = new Map();
    this.leases = new Map();
    this.done = new Set();
    this.metrics = { fills: 0, refreshes: 0, refreshFailures: 0, gcDeleted: 0, gcFailures: 0 };
  }

  async flight(name, fn) {
    if (this.flights.has(name)) return this.flights.get(name);
    const p = (async () => { try { return await fn(); } finally { this.flights.delete(name); } })();
    this.flights.set(name, p);
    return p;
  }

  async getPool(selKey) {
    if (this.pools.has(selKey)) return this.pools.get(selKey);
    if (!this.loading.has(selKey)) {
      this.loading.set(selKey, (async () => {
        const stored = await this.store.get(`pool:${selKey}`);
        if (stored && !this.pools.has(selKey)) this.pools.set(selKey, stored);
        this.loading.delete(selKey);
        return this.pools.get(selKey) || null;
      })());
    }
    return this.loading.get(selKey);
  }

  async save(pool) { await this.store.put(`pool:${pool.selKey}`, pool); }

  _blank(selKey, selection, photos) {
    const t = this.now();
    return { v: 2, selKey, selection, photos, pos: 0, cycle: 0, served: 0, generation: 1, created: t, lastAccess: t,
      renders: {}, failures: 0, nextRefreshAfter: 0 };
  }

  async fill(selKey, selection) {
    const snap = await this.snapshots?.get(selKey).catch(() => null);
    let photos = snap?.photos?.length ? snap.photos : null;
    if (!photos) {
      const r = await this.discover(selection, this.cfg.POOL_FILL_COUNT);
      if (!r.ok) return r;
      if (!r.photos.length) return { ok: false, code: 'empty', retryAfter: 60, message: 'No images available' };
      photos = r.photos;
      this.metrics.fills += 1;
    }
    const pool = this._blank(selKey, selection, photos.slice(0, this.cfg.POOL_MAX));
    this.pools.set(selKey, pool);
    await this.save(pool);
    await this.snapshots?.put(selKey, pool).catch(() => {});
    return { ok: true };
  }

  async acquire({ selKey, selection, renderKey, render }) {
    let pool = await this.getPool(selKey);
    if (!pool || !pool.photos.length) {
      const f = await this.flight(`fill:${selKey}`, () => this.fill(selKey, selection));
      if (!f.ok) return f;
      pool = this.pools.get(selKey);
    }
    return this.serve(pool, renderKey, render);
  }

  async serve(pool, renderKey, render) {
    // Synchronous section: no awaits between reading and advancing the cursor.
    const now = this.now();
    const n = pool.photos.length;
    const idx = pool.cycle % n;
    const photo = pool.photos[idx];
    pool.cycle = (idx + 1) % n;
    pool.pos = Math.min(pool.pos + 1, n);
    pool.served += 1;
    pool.lastAccess = now;
    const retiredRenders = this._touchRender(pool, renderKey, render, now);
    const plan = [];
    const seen = new Set();
    for (let k = 0; k <= this.cfg.MATERIALIZE_AHEAD && k < n; k += 1) {
      const p = pool.photos[(idx + k) % n];
      const key = `${renderKey}/${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lease = this.leases.get(key);
      if (this.done.has(key) || (lease && lease > now)) continue;
      this.leases.set(key, now + this.cfg.MATERIALIZE_LEASE_MS);
      plan.push(p);
    }
    const unseen = n - pool.pos;
    const refreshDue = unseen <= this.cfg.REFRESH_THRESHOLD && now >= pool.nextRefreshAfter && !this.flights.has(`refresh:${pool.selKey}`);
    await this.save(pool);
    if (retiredRenders.length) await this.retire(pool.selKey, pool.photos, retiredRenders, now + this.cfg.GC_GRACE_MS);
    await this.onUse?.(photo);
    return { ok: true, photo, plan, unseen, size: n, refreshDue, generation: pool.generation };
  }

  _touchRender(pool, renderKey, render, now) {
    pool.renders[renderKey] = { last: now, render };
    const keys = Object.keys(pool.renders);
    const evicted = [];
    if (keys.length > this.cfg.MAX_RENDERS_PER_POOL) {
      keys.sort((a, b) => pool.renders[a].last - pool.renders[b].last);
      for (const k of keys.slice(0, keys.length - this.cfg.MAX_RENDERS_PER_POOL)) { evicted.push(k); delete pool.renders[k]; }
    }
    return evicted;
  }

  finishMaterialize(results) {
    for (const r of results || []) {
      const key = `${r.renderKey}/${r.photoId}`;
      this.leases.delete(key);
      if (r.ok) this.done.add(key);
    }
    if (this.done.size > 5000) this.done.clear();
  }

  async refresh(selKey) {
    return this.flight(`refresh:${selKey}`, async () => {
      const pool = await this.getPool(selKey);
      if (!pool) return { ok: false, code: 'no_pool' };
      const fail = async (r) => {
        const cur = this.pools.get(selKey);
        cur.failures += 1;
        const wait = r.retryAfter > 0 && r.code === 'rate_limited' ? r.retryAfter * 1000 : Math.min(2 ** cur.failures * 60000, this.cfg.REFRESH_BACKOFF_MAX_MS);
        cur.nextRefreshAfter = this.now() + Math.min(wait, this.cfg.REFRESH_BACKOFF_MAX_MS * 6);
        this.metrics.refreshFailures += 1;
        await this.save(cur);
        return { ok: false, code: r.code };
      };
      const r = await this.discover(pool.selection, this.cfg.POOL_FILL_COUNT);
      if (!r.ok) return fail(r);
      if (!r.photos.length) return fail({ code: 'empty' });
      // Re-read the live pool after the await so cursor progress is never overwritten.
      const cur = this.pools.get(selKey);
      const n = cur.photos.length;
      const unseen = cur.pos < n ? cur.photos.slice(cur.pos) : [];
      const ids = new Set(unseen.map((p) => p.id));
      const merged = [...unseen, ...r.photos.filter((p) => !ids.has(p.id))].slice(0, this.cfg.POOL_MAX);
      const keep = new Set(merged.map((p) => p.id));
      const retired = cur.photos.filter((p) => !keep.has(p.id));
      Object.assign(cur, { photos: merged, pos: 0, cycle: 0, generation: cur.generation + 1, failures: 0, nextRefreshAfter: 0 });
      await this.save(cur);
      await this.snapshots?.put(selKey, cur).catch(() => {});
      await this.retire(selKey, retired, Object.keys(cur.renders), this.now() + this.cfg.GC_GRACE_MS);
      this.metrics.refreshes += 1;
      return { ok: true, added: r.photos.length, size: merged.length };
    });
  }

  async retire(selKey, photos, renderKeys, after) {
    if (!photos.length || !renderKeys.length) return;
    const id = `gc:${String(this.now()).padStart(15, '0')}:${rand()}`;
    const items = photos.flatMap((p) => renderKeys.map((rk) => ({ rk, pid: p.id })));
    await this.store.put(id, { id, selKey, after, attempts: 0, items });
  }

  async runGc(max = 50) {
    const entries = [...(await this.store.list({ prefix: 'gc:' })).values()].slice(0, max);
    const now = this.now();
    let deleted = 0;
    for (const e of entries) {
      if (e.after > now) continue;
      const pool = this.pools.get(e.selKey) || (await this.store.get(`pool:${e.selKey}`));
      const active = new Set((pool?.photos || []).flatMap((p) => Object.keys(pool.renders || {}).map((rk) => `${rk}/${p.id}`)));
      const items = e.items.filter((i) => !active.has(`${i.rk}/${i.pid}`));
      try {
        for (let i = 0; i < items.length; i += 500) {
          await this.blobs.deleteMany(items.slice(i, i + 500).map((x) => objectKey(x.rk, x.pid)));
        }
        for (const i of items) this.done.delete(`${i.rk}/${i.pid}`);
        deleted += items.length;
        this.metrics.gcDeleted += items.length;
        await this.store.delete(e.id);
      } catch (error) {
        e.attempts += 1;
        e.after = now + Math.min(2 ** e.attempts * 60000, 6 * 3600000);
        this.metrics.gcFailures += 1;
        await this.store.put(e.id, e);
      }
    }
    return { deleted };
  }

  async sweepIdle() {
    const now = this.now();
    const all = await this.store.list({ prefix: 'pool:' });
    let swept = 0;
    for (const [key, pool] of all) {
      if (now - pool.lastAccess <= this.cfg.POOL_IDLE_MS) continue;
      await this.retire(pool.selKey, pool.photos, Object.keys(pool.renders || {}), now);
      await this.store.delete(key);
      await this.snapshots?.delete(pool.selKey).catch(() => {});
      this.pools.delete(pool.selKey);
      swept += 1;
    }
    return { swept };
  }

  async dueRefreshes(max = 3) {
    const all = await this.store.list({ prefix: 'pool:' });
    const now = this.now();
    return [...all.values()]
      .filter((p) => p.photos.length - p.pos <= this.cfg.REFRESH_THRESHOLD && now >= p.nextRefreshAfter && now - p.lastAccess < 24 * 3600000)
      .slice(0, max).map((p) => p.selKey);
  }

  stats() {
    return { pools: this.pools.size, leases: this.leases.size, materialized: this.done.size, ...this.metrics };
  }
}
