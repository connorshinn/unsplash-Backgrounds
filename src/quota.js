// Authoritative per-application Unsplash budget accounting, shared by the
// production Worker and (through the broker) the CDN pilot.
const HOUR = 3600000;

export class QuotaState {
  /** @param apps ordered by priority: [{id}] */
  constructor(apps, cfg, snapshot = null) {
    this.cfg = cfg;
    this.order = apps.map((a) => a.id);
    this.apps = {};
    for (const id of this.order) {
      this.apps[id] = {
        limit: cfg.ASSUMED_HOURLY_LIMIT, remaining: cfg.ASSUMED_HOURLY_LIMIT, resetAt: 0,
        lowUntil: 0, cooldownUntil: 0, cooldownStep: 0, invalidUntil: 0, lastStatus: null,
        ...(snapshot?.apps?.[id] || {}),
        inflight: 0,
      };
    }
    this.pilot = { windowStart: 0, used: 0, ...(snapshot?.pilot || {}), inflight: 0 };
    this.reservations = new Map();
    this.seq = 0;
  }

  snapshot() {
    const apps = {};
    for (const [id, a] of Object.entries(this.apps)) apps[id] = { ...a, inflight: 0 };
    return { apps, pilot: { ...this.pilot, inflight: 0 } };
  }

  roll(now) {
    for (const a of Object.values(this.apps)) {
      if (a.resetAt && now >= a.resetAt) {
        a.remaining = a.limit;
        a.resetAt = 0;
        a.lowUntil = 0;
      } else if (a.probeAt && now >= a.probeAt) {
        // Header-less 429: allow a single probe request once the cooldown ends.
        a.probeAt = 0;
        a.lowUntil = 0;
        a.remaining = Math.max(a.remaining, this.cfg.TRACK_RESERVE + 1);
      }
    }
    if (this.pilot.windowStart && now - this.pilot.windowStart >= HOUR) {
      this.pilot.windowStart = 0;
      this.pilot.used = 0;
    }
  }

  _blockedUntil(a, now) {
    return Math.max(a.cooldownUntil, a.invalidUntil, a.lowUntil, 0) > now ? Math.max(a.cooldownUntil, a.invalidUntil, a.lowUntil) : 0;
  }

  /**
   * @param consumer 'prod' | 'pilot'
   * @param kind 'discovery' | 'track'
   * @param opts {appId?: string, exclude?: string[]}
   */
  reserve(consumer, kind, now, opts = {}) {
    this.roll(now);
    const { cfg } = this;
    if (consumer === 'pilot') {
      const p = this.pilot;
      if (p.used + p.inflight >= cfg.PILOT_HOURLY_ALLOWANCE) {
        const at = (p.windowStart || now) + HOUR;
        return { ok: false, reason: 'pilot_allowance', retryAfterMs: Math.max(0, at - now) };
      }
    }
    const candidates = opts.appId ? [opts.appId] : this.order.filter((id) => !(opts.exclude || []).includes(id));
    let soonest = Infinity;
    let sawInvalid = false;
    for (const id of candidates) {
      const a = this.apps[id];
      if (!a) continue;
      if (a.invalidUntil > now) { sawInvalid = true; soonest = Math.min(soonest, a.invalidUntil); continue; }
      if (a.cooldownUntil > now) { soonest = Math.min(soonest, a.cooldownUntil); continue; }
      const eff = a.remaining - a.inflight;
      const needed = consumer === 'pilot' ? cfg.PILOT_PROD_RESERVE + 1
        : kind === 'discovery' ? cfg.TRACK_RESERVE + 1 : 1;
      const sticky = kind === 'discovery' && a.lowUntil > now;
      if (sticky || eff < needed) {
        if (!a.resetAt) a.resetAt = now + HOUR;
        if (consumer === 'prod' && kind === 'discovery' && eff < needed) a.lowUntil = Math.max(a.lowUntil, a.resetAt);
        soonest = Math.min(soonest, a.resetAt);
        continue;
      }
      if (!a.resetAt) a.resetAt = now + HOUR;
      a.inflight += 1;
      if (consumer === 'pilot') {
        if (!this.pilot.windowStart) this.pilot.windowStart = now;
        this.pilot.inflight += 1;
      }
      const id2 = ++this.seq;
      this.reservations.set(id2, { appId: id, consumer });
      return { ok: true, appId: id, id: id2 };
    }
    const reason = candidates.length === 0 ? 'no_credentials' : sawInvalid && soonest !== Infinity && candidates.every((c) => this.apps[c]?.invalidUntil > now) ? 'invalid' : 'exhausted';
    return { ok: false, reason, retryAfterMs: soonest === Infinity ? HOUR : Math.max(1000, soonest - now) };
  }

  /** Release without sending (e.g. validation failure before the request). */
  cancel(res) {
    const r = this.reservations.get(res.id);
    if (!r) return;
    this.reservations.delete(res.id);
    this.apps[r.appId].inflight = Math.max(0, this.apps[r.appId].inflight - 1);
    if (r.consumer === 'pilot') this.pilot.inflight = Math.max(0, this.pilot.inflight - 1);
  }

  /**
   * @param outcome {status:number|null, remaining?:number|null, limit?:number|null,
   *                 retryAfter?:number|null, body?:string, networkError?:boolean}
   * @returns {{class:'ok'|'quota'|'invalid'|'transient'|'client'}}
   */
  settle(res, outcome, now) {
    const r = this.reservations.get(res.id);
    if (!r) return { class: 'transient' };
    this.reservations.delete(res.id);
    const a = this.apps[r.appId];
    a.inflight = Math.max(0, a.inflight - 1);
    if (r.consumer === 'pilot') {
      this.pilot.inflight = Math.max(0, this.pilot.inflight - 1);
      this.pilot.used += 1;
    }
    a.lastStatus = outcome.status ?? 'network';
    if (outcome.limit > 0) a.limit = outcome.limit;
    const hasRemaining = Number.isFinite(outcome.remaining) && outcome.remaining >= 0;
    const decrement = () => { a.remaining = Math.max(0, a.remaining - 1); };
    const status = outcome.status;

    const quotaHit = () => {
      a.remaining = 0;
      const ra = outcome.retryAfter > 0 ? Math.min(outcome.retryAfter * 1000, 6 * HOUR) : null;
      a.cooldownStep = ra ? a.cooldownStep : Math.min((a.cooldownStep || 5 * 60000) * 2, HOUR);
      a.cooldownUntil = now + (ra ?? a.cooldownStep);
      a.lowUntil = Math.max(a.lowUntil, a.cooldownUntil);
      if (ra) a.resetAt = a.cooldownUntil; // provider told us when the window reopens
      else a.probeAt = a.cooldownUntil;
      return { class: 'quota' };
    };
    if (outcome.networkError || status === null) { decrement(); return { class: 'transient' }; }
    if (status === 429) return quotaHit();
    if (status === 403) {
      if (/rate limit/i.test(outcome.body || '') || outcome.remaining === 0) return quotaHit();
      a.invalidUntil = now + HOUR;
      return { class: 'invalid' };
    }
    if (status === 401) { a.invalidUntil = now + 6 * HOUR; return { class: 'invalid' }; }
    if (hasRemaining) a.remaining = outcome.remaining; else decrement();
    if (status >= 500) return { class: 'transient' };
    if (status >= 200 && status < 300) { a.cooldownStep = 0; a.invalidUntil = 0; return { class: 'ok' }; }
    return { class: 'client' };
  }

  summary(now) {
    this.roll(now);
    const out = { pilot: { used: this.pilot.used, allowance: this.cfg.PILOT_HOURLY_ALLOWANCE, windowResetsAt: this.pilot.windowStart ? this.pilot.windowStart + HOUR : null }, apps: {} };
    for (const id of this.order) {
      const a = this.apps[id];
      out.apps[id] = { limit: a.limit, remaining: a.remaining, inflight: a.inflight, resetAt: a.resetAt || null,
        cooldownUntil: a.cooldownUntil > now ? a.cooldownUntil : null, invalidUntil: a.invalidUntil > now ? a.invalidUntil : null,
        preferredPaused: a.lowUntil > now, lastStatus: a.lastStatus };
    }
    return out;
  }
}
