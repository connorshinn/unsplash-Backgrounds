// Public reusable defaults. Installation-specific values (application IDs,
// resource IDs, domain) live in wrangler.toml [vars]; any numeric default below
// can be overridden with an environment variable of the same name.
export const DEFAULTS = {
  // Pool behaviour
  POOL_FILL_COUNT: 30, // photos per discovery call (Unsplash maximum)
  POOL_MAX: 60, // max photos kept per selection pool
  REFRESH_THRESHOLD: 5, // refresh when this many unseen photos remain
  REFRESH_BACKOFF_MAX_MS: 3600000,
  POOL_IDLE_MS: 14 * 24 * 3600 * 1000, // retire pools idle this long
  MAX_RENDERS_PER_POOL: 8, // rendered size variants kept per pool
  GC_GRACE_MS: 15 * 60 * 1000, // delay before retired objects are deleted
  // Rendering/materialisation
  MATERIALIZE_AHEAD: 6, // upcoming photos stored per request (lazy, bounded)
  MATERIALIZE_CONCURRENCY: 3,
  MATERIALIZE_LEASE_MS: 2 * 60 * 1000,
  IMAGE_TIMEOUT_MS: 20000,
  // Unsplash API budget (applications report their own limit; this is the
  // assumed limit until a response header says otherwise)
  ASSUMED_HOURLY_LIMIT: 50,
  TRACK_RESERVE: 10, // per-application budget kept for tracking events
  PILOT_HOURLY_ALLOWANCE: 5, // JSON calls/hour for the CDN pilot (all keys, incl. tracking)
  PILOT_PROD_RESERVE: 15, // pilot may only use an app with more than this left
  API_TIMEOUT_MS: 10000,
  // Tracking events
  EVENT_MAX_PENDING: 300,
  EVENT_TTL_MS: 24 * 3600 * 1000,
  EVENT_MAX_ATTEMPTS: 4,
  DRAIN_BATCH: 5,
  // Legacy (pre-v2-schema) KV entries
  LEGACY_IDLE_MS: 14 * 24 * 3600 * 1000,
};

export function loadConfig(env = {}) {
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) cfg[key] = n;
  }
  return cfg;
}

export function applicationsFromEnv(env = {}) {
  const apps = [];
  if (env.UNSPLASH_ACCESS_KEY) {
    apps.push({ id: String(env.UNSPLASH_PRIMARY_APP_ID || 'primary'), name: 'primary', keyEnv: 'UNSPLASH_ACCESS_KEY' });
  }
  if (env.UNSPLASH_SECONDARY_ACCESS_KEY) {
    apps.push({ id: String(env.UNSPLASH_SECONDARY_APP_ID || 'secondary'), name: 'secondary', keyEnv: 'UNSPLASH_SECONDARY_ACCESS_KEY' });
  }
  return apps;
}
