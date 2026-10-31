// Pending download-tracking events. Each event is sent with the Access Key of the
// application that discovered the photo and is never re-attributed.
const rand = () => Math.random().toString(36).slice(2, 8);

export class EventQueue {
  constructor({ store, cfg, gateway, now = () => Date.now() }) {
    this.store = store; this.cfg = cfg; this.gateway = gateway; this.now = now;
    this.events = null;
    this.dropped = 0;
  }

  async load() {
    if (!this.events) {
      const listed = await this.store.list({ prefix: 'ev:' });
      this.events = new Map(listed);
    }
    return this.events;
  }

  async enqueue(consumer, photo) {
    if (!photo?.dl) return;
    const events = await this.load();
    const mine = [...events.values()].filter((e) => e.consumer === consumer).sort((a, b) => a.created - b.created);
    while (mine.length >= this.cfg.EVENT_MAX_PENDING) {
      const old = mine.shift();
      events.delete(old.id);
      await this.store.delete(old.id);
      this.dropped += 1;
    }
    const created = this.now();
    const ev = { id: `ev:${String(created).padStart(15, '0')}:${rand()}`, consumer, photoId: photo.id, app: photo.app, dl: photo.dl, created, attempts: 0, nextAfter: 0 };
    events.set(ev.id, ev);
    await this.store.put(ev.id, ev);
  }

  size() { return this.events ? this.events.size : 0; }

  async drain(max = this.cfg.DRAIN_BATCH) {
    const events = await this.load();
    const order = [...events.values()].sort((a, b) => (a.consumer === b.consumer ? a.created - b.created : a.consumer === 'prod' ? -1 : 1));
    const blocked = new Set();
    let sent = 0;
    const stats = { done: 0, dropped: 0, deferred: 0, retried: 0 };
    for (const ev of order) {
      if (sent >= max) break;
      if (!events.has(ev.id)) continue;
      const now = this.now();
      if (ev.created + this.cfg.EVENT_TTL_MS < now) { await this._remove(ev); this.dropped += 1; stats.dropped += 1; continue; }
      if (ev.nextAfter > now || blocked.has(`${ev.consumer}:${ev.app}`)) continue;
      sent += 1;
      const outcome = await this.gateway.trackOne(ev.consumer, ev);
      if (outcome === 'done') { await this._remove(ev); stats.done += 1; }
      else if (outcome === 'drop') { await this._remove(ev); stats.dropped += 1; }
      else if (outcome === 'deferred') { blocked.add(`${ev.consumer}:${ev.app}`); stats.deferred += 1; }
      else {
        ev.attempts += 1;
        if (ev.attempts >= this.cfg.EVENT_MAX_ATTEMPTS) { await this._remove(ev); this.dropped += 1; stats.dropped += 1; }
        else { ev.nextAfter = now + 2 ** ev.attempts * 60000; await this.store.put(ev.id, ev); stats.retried += 1; }
      }
    }
    return stats;
  }

  async _remove(ev) {
    this.events.delete(ev.id);
    await this.store.delete(ev.id);
  }
}
