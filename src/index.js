import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createApp } from './app.js';
import { BROKER_API_VERSION, CoordinatorCore } from './core.js';

const SNAPSHOT_TTL = 30 * 24 * 3600;

function adapters(env) {
  return {
    blobs: {
      async deleteMany(keys) {
        const safe = keys.filter((k) => k.startsWith('v2/r/')); // never touch anything outside our prefix
        if (safe.length) await env.UNSPLASH_CACHE.delete(safe);
      },
    },
    snapshots: {
      get: (k) => env.UNSPLASH_CACHE_METADATA.get(`v2:snap:${k}`, 'json'),
      put: (k, pool) => env.UNSPLASH_CACHE_METADATA.put(`v2:snap:${k}`, JSON.stringify({
        v: 2, selection: pool.selection, photos: pool.photos, generation: pool.generation, saved: Date.now(),
      }), { expirationTtl: SNAPSHOT_TTL }),
      delete: (k) => env.UNSPLASH_CACHE_METADATA.delete(`v2:snap:${k}`),
    },
  };
}

export class Coordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new CoordinatorCore({ store: ctx.storage, env, ...adapters(env) });
    ctx.blockConcurrencyWhile(() => this.core.init());
  }
  acquire(args) { return this.core.acquire(args); }
  refresh(selKey) { return this.core.refresh(selKey); }
  finishMaterialize(results) { return this.core.finishMaterialize(results); }
  drain() { return this.core.drain(); }
  maintenance(opts) { return this.core.maintenance(opts); }
  status() { return this.core.status(); }
  brokerDiscover(consumer, req) { return this.core.brokerDiscover(consumer, req); }
  brokerTrack(consumer, photo) { return this.core.brokerTrack(consumer, photo); }
}

/**
 * Narrow internal surface for the separately deployed CDN pilot (service binding
 * with `entrypoint = "PilotBroker"`). The consumer identity is fixed here; callers
 * cannot choose it and cannot reach rotation, pool or cache operations.
 */
export class PilotBroker extends WorkerEntrypoint {
  #stub() { return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName('main')); }
  version() { return BROKER_API_VERSION; }
  discover(req) { return this.#stub().brokerDiscover('pilot', { selection: req?.selection, count: req?.count }); }
  track(photo) { return this.#stub().brokerTrack('pilot', photo); }
  async status() {
    const s = await this.#stub().status();
    return { version: s.version, quota: s.quota, pendingEvents: s.pendingEvents };
  }
}

export default createApp();
