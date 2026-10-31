// The only code that holds Unsplash Access Keys and talks to api.unsplash.com.
import { discoveryParams } from './params.js';

const API = 'https://api.unsplash.com';

function toPhoto(p, appId) {
  if (!p || !p.id || !p.urls?.raw) return null;
  return {
    id: String(p.id), raw: p.urls.raw, dl: p.links?.download_location || null,
    name: p.user?.name || '', app: appId, w: p.width || null, h: p.height || null,
  };
}

export function isTrackingUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'api.unsplash.com' && /^\/photos\/[^/]+\/download$/.test(u.pathname);
  } catch { return false; }
}

export class UnsplashGateway {
  constructor({ apps, env, cfg, quota, persist, fetchFn = (...a) => fetch(...a), now = () => Date.now(), apiBase = API }) {
    this.apps = apps; this.env = env; this.cfg = cfg; this.quota = quota; this.persist = persist;
    this.fetch = fetchFn; this.now = now; this.apiBase = apiBase;
    this.counters = { discoveries: 0, trackingOk: 0, trackingRetry: 0, trackingDropped: 0 };
  }

  keyFor(appId) {
    const app = this.apps.find((a) => a.id === appId);
    return app ? this.env[app.keyEnv] : null;
  }

  async _call(res, url) {
    let out;
    try {
      const response = await this.fetch(url, {
        headers: { Authorization: `Client-ID ${this.keyFor(res.appId)}`, 'Accept-Version': 'v1' },
        signal: AbortSignal.timeout(this.cfg.API_TIMEOUT_MS),
      });
      const num = (h) => { const v = response.headers.get(h); return v === null ? null : Number(v); };
      const body = response.ok ? '' : await response.clone().text().catch(() => '');
      const verdict = this.quota.settle(res, {
        status: response.status, remaining: num('X-Ratelimit-Remaining'), limit: num('X-Ratelimit-Limit'),
        retryAfter: num('Retry-After'), body,
      }, this.now());
      out = { response, verdict };
    } catch (error) {
      const verdict = this.quota.settle(res, { status: null, networkError: true }, this.now());
      out = { response: null, verdict, error };
    }
    await this.persist();
    return out;
  }

  /** @returns {{ok:true,photos,appId}|{ok:false,code,retryAfter,message}} */
  async discover(consumer, selection, count) {
    const n = Math.max(1, Math.min(30, Math.floor(count) || 1));
    const tried = [];
    let last = null;
    for (let i = 0; i < this.quota.order.length; i += 1) {
      const res = this.quota.reserve(consumer, 'discovery', this.now(), { exclude: tried });
      if (!res.ok) {
        await this.persist();
        if (tried.length && last && (last.code === 'upstream' || last.code === 'bad_request')) return last;
        const code = res.reason === 'invalid' ? 'forbidden' : res.reason === 'no_credentials' ? 'unconfigured' : 'rate_limited';
        return { ok: false, code, reason: res.reason, retryAfter: Math.ceil(res.retryAfterMs / 1000), message: res.reason };
      }
      tried.push(res.appId);
      const url = `${this.apiBase}/photos/random?${discoveryParams(selection, n)}`;
      const { response, verdict } = await this._call(res, url);
      if (response?.ok) {
        this.counters.discoveries += 1;
        let json;
        try { json = await response.json(); } catch { json = null; }
        const list = Array.isArray(json) ? json : json ? [json] : [];
        const photos = list.map((p) => toPhoto(p, res.appId)).filter(Boolean);
        return { ok: true, photos, appId: res.appId };
      }
      const status = response?.status ?? 0;
      last = { ok: false, code: verdict.class === 'quota' ? 'rate_limited' : verdict.class === 'invalid' ? 'forbidden' : status === 400 || status === 404 ? 'bad_request' : 'upstream', retryAfter: 60, message: `Unsplash status ${status}` };
      if (verdict.class === 'client') return last;
    }
    if (last?.code === 'rate_limited') {
      const s = this.quota.summary(this.now());
      const resets = Object.values(s.apps).map((a) => a.cooldownUntil || a.resetAt).filter(Boolean);
      last.retryAfter = resets.length ? Math.max(1, Math.ceil((Math.min(...resets) - this.now()) / 1000)) : 3600;
    }
    return last || { ok: false, code: 'unconfigured', retryAfter: 0, message: 'No Unsplash credentials' };
  }

  /** @returns 'done' | 'drop' | 'deferred' (no attempt consumed) | 'retry' (attempt consumed) */
  async trackOne(consumer, event) {
    if (!isTrackingUrl(event.dl)) return 'drop';
    const res = this.quota.reserve(consumer, 'track', this.now(), { appId: event.app });
    if (!res.ok) { await this.persist(); return 'deferred'; }
    const { response, verdict } = await this._call(res, event.dl);
    if (response?.ok) { this.counters.trackingOk += 1; return 'done'; }
    if (response && response.status === 404) return 'drop';
    if (verdict.class === 'quota' || verdict.class === 'invalid') return 'deferred';
    if (verdict.class === 'client') return 'drop';
    this.counters.trackingRetry += 1;
    return 'retry';
  }
}
