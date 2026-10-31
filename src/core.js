// Coordinator logic (runs inside the Durable Object; also directly testable).
import { applicationsFromEnv, loadConfig } from './config.js';
import { EventQueue } from './events.js';
import { UnsplashGateway, isTrackingUrl } from './gateway.js';
import { normalizeSelection, selectionKey } from './params.js';
import { PoolManager } from './pools.js';
import { QuotaState } from './quota.js';

export const BROKER_API_VERSION = 1;

export class CoordinatorCore {
  constructor({ store, env, blobs, snapshots, fetchFn, now = () => Date.now(), apiBase }) {
    this.store = store; this.env = env; this.now = now;
    this.cfg = loadConfig(env);
    this.apps = applicationsFromEnv(env);
    this.blobs = blobs; this.snapshots = snapshots; this.fetchFn = fetchFn; this.apiBase = apiBase;
  }

  async init() {
    const saved = await this.store.get('quota');
    this.quota = new QuotaState(this.apps, this.cfg, saved);
    this.gateway = new UnsplashGateway({
      apps: this.apps, env: this.env, cfg: this.cfg, quota: this.quota, now: this.now,
      fetchFn: this.fetchFn, apiBase: this.apiBase,
      persist: () => this.store.put('quota', this.quota.snapshot()),
    });
    this.events = new EventQueue({ store: this.store, cfg: this.cfg, gateway: this.gateway, now: this.now });
    this.pools = new PoolManager({
      store: this.store, cfg: this.cfg, now: this.now, blobs: this.blobs, snapshots: this.snapshots,
      discover: (selection, count) => this.gateway.discover('prod', selection, count),
      onUse: (photo) => this.events.enqueue('prod', photo),
    });
    return this;
  }

  acquire(args) { return this.pools.acquire(args); }
  refresh(selKey) { return this.pools.refresh(selKey); }
  async finishMaterialize(results) { this.pools.finishMaterialize(results); return true; }
  drain() { return this.events.drain(); }

  async maintenance({ full = false } = {}) {
    const out = { drain: await this.events.drain() };
    for (const key of await this.pools.dueRefreshes()) out[`refresh:${key}`] = await this.pools.refresh(key);
    out.gc = await this.pools.runGc(full ? 200 : 50);
    if (full) out.sweep = await this.pools.sweepIdle();
    return out;
  }

  // ---- narrow broker surface (consumer identity fixed by the entrypoint) ----
  async brokerDiscover(consumer, req) {
    const n = normalizeSelection(req?.selection);
    if (n.error) return { version: BROKER_API_VERSION, ok: false, code: 'bad_request', message: n.error.message, retryAfter: 0 };
    const count = Math.max(1, Math.min(30, Math.floor(Number(req?.count)) || 30));
    const r = await this.gateway.discover(consumer, n.selection, count);
    return { version: BROKER_API_VERSION, ...r };
  }

  async brokerTrack(consumer, photo) {
    const app = this.apps.find((a) => a.id === String(photo?.app));
    if (!app || !photo?.id || !isTrackingUrl(photo.dl)) {
      return { version: BROKER_API_VERSION, ok: false, code: 'bad_request' };
    }
    await this.events.enqueue(consumer, { id: String(photo.id), app: app.id, dl: photo.dl });
    return { version: BROKER_API_VERSION, ok: true };
  }

  async status() {
    const events = await this.events.load();
    const byConsumer = {};
    for (const e of events.values()) byConsumer[e.consumer] = (byConsumer[e.consumer] || 0) + 1;
    return {
      version: BROKER_API_VERSION,
      quota: this.quota.summary(this.now()),
      pendingEvents: byConsumer,
      eventsDropped: this.events.dropped,
      gateway: this.gateway.counters,
      pools: this.pools.stats(),
      config: Object.fromEntries(['POOL_FILL_COUNT', 'REFRESH_THRESHOLD', 'TRACK_RESERVE', 'PILOT_HOURLY_ALLOWANCE', 'PILOT_PROD_RESERVE', 'MATERIALIZE_AHEAD'].map((k) => [k, this.cfg[k]])),
    };
  }
}

export { selectionKey };
