import { CoordinatorCore } from '../src/core.js';
import { handleFetch } from '../src/app.js';

export class FakeStore {
  constructor() { this.m = new Map(); this.failPut = false; }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v) { if (this.failPut) throw new Error('store put failed'); this.m.set(k, structuredClone(v)); }
  async delete(k) { this.m.delete(k); return true; }
  async list({ prefix = '' } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)]));
  }
}

export class FakeR2 {
  constructor() { this.m = new Map(); this.failDelete = false; this.failGet = false; this.failPut = false; this.deleted = []; }
  async get(k) {
    if (this.failGet) throw new Error('r2 get failed');
    const o = this.m.get(k);
    return o ? { body: o.body, size: o.size, httpMetadata: o.httpMetadata } : null;
  }
  async head(k) { return this.m.has(k) ? {} : null; }
  async put(k, body, opts) {
    if (this.failPut) throw new Error('r2 put failed');
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    this.m.set(k, { body: buf, size: buf.byteLength, httpMetadata: opts?.httpMetadata });
  }
  async delete(keys) {
    if (this.failDelete) throw new Error('r2 delete failed');
    for (const k of [].concat(keys)) { this.m.delete(k); this.deleted.push(k); }
  }
}

export class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list() { return { keys: [...this.m.keys()].map((name) => ({ name })), list_complete: true }; }
}

/** Scriptable Unsplash + image CDN. */
export function makeUpstream(opts = {}) {
  const st = {
    calls: [], discoveries: 0, tracks: [], imageFetches: 0, seq: 0, photoName: opts.photoName || 'Ada Lovelace',
    rules: {}, // per access key: {status, headers, body, retryAfter}
    remaining: {}, imageStatus: 200, perCall: opts.perCall ?? 30, keys: {},
  };
  st.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = (init.headers?.Authorization || '').replace('Client-ID ', '');
    st.calls.push({ url: url.toString(), key: auth });
    if (st.delay && url.hostname === 'api.unsplash.com') await new Promise((r) => setTimeout(r, st.delay));
    if (url.hostname === 'images.unsplash.com') {
      st.imageFetches += 1;
      if (st.imageStatus !== 200) return new Response('x', { status: st.imageStatus });
      return new Response(new Uint8Array(64).fill(7), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '64' } });
    }
    const rule = st.rules[auth] || {};
    const rem = (st.remaining[auth] ?? 50) - (rule.status && rule.status !== 200 ? 0 : 1);
    const hdr = { 'X-Ratelimit-Limit': '50', 'X-Ratelimit-Remaining': String(Math.max(0, rem)), ...(rule.headers || {}) };
    if (rule.status && rule.status !== 200) {
      if (rule.retryAfter) hdr['Retry-After'] = String(rule.retryAfter);
      return new Response(rule.body || 'err', { status: rule.status, headers: hdr });
    }
    st.remaining[auth] = rem;
    if (url.pathname === '/photos/random') {
      st.discoveries += 1;
      st.lastQuery = Object.fromEntries(url.searchParams);
      const photos = Array.from({ length: opts.perCall ?? st.perCall }, () => {
        const id = `p${++st.seq}`;
        return { id, width: 4000, height: 2667, urls: { raw: `https://images.unsplash.com/${id}?ixid=abc${id}` },
          links: { download_location: `https://api.unsplash.com/photos/${id}/download?ixid=abc${id}` }, user: { name: st.photoName } };
      });
      return new Response(JSON.stringify(photos), { status: 200, headers: hdr });
    }
    if (/\/download$/.test(url.pathname)) {
      st.tracks.push({ url: url.toString(), key: auth });
      return new Response('{}', { status: 200, headers: hdr });
    }
    return new Response('nf', { status: 404 });
  };
  return st;
}

export const ENV_BASE = {
  UNSPLASH_ACCESS_KEY: 'KEY1', UNSPLASH_SECONDARY_ACCESS_KEY: 'KEY2',
  UNSPLASH_PRIMARY_APP_ID: '813645', UNSPLASH_SECONDARY_APP_ID: '1116485',
};

export async function makeWorld({ env: extra = {}, upstream, clock } = {}) {
  const up = upstream || makeUpstream();
  const t = clock || { now: 1_800_000_000_000 };
  const env = { ...ENV_BASE, ...extra, UNSPLASH_CACHE: new FakeR2(), UNSPLASH_CACHE_METADATA: new FakeKV(), __fetch: up.fetch };
  const store = new FakeStore();
  const blobs = { deleteMany: async (keys) => env.UNSPLASH_CACHE.delete(keys) };
  const snapshots = {
    get: async (k) => env.UNSPLASH_CACHE_METADATA.get(`v2:snap:${k}`, 'json'),
    put: async (k, p) => env.UNSPLASH_CACHE_METADATA.put(`v2:snap:${k}`, JSON.stringify({ photos: p.photos })),
    delete: async (k) => env.UNSPLASH_CACHE_METADATA.delete(`v2:snap:${k}`),
  };
  const core = await new CoordinatorCore({ store, env, blobs, snapshots, fetchFn: up.fetch, now: () => t.now }).init();
  env.COORDINATOR = { idFromName: () => 'main', get: () => core };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const req = async (path = '/?auth=true&topics=nature&w=3840&h=1910&orientation=landscape', init = {}) => {
    const res = await handleFetch(new Request(`https://unsplash.test${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { env, core, store, up, t, req, ctx, flush: () => Promise.all(pending.splice(0)) };
}
