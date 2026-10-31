// Typed, canonical request parameters. Selection (what photos) is separated from
// rendering (what bytes), so different sizes share one photo pool.
export const TOPIC_SLUG_TO_ID = {
  '3d': 'whIY33yKE84', '3d-renders': 'CDwuwXJAbEw', animals: 'Jpg6Kidl-Hk',
  'architecture-interior': 'M8jVbLbTRws', experimental: 'qPYsDzvJOYc',
  'fashion-beauty': 'S4MKLAsBB74', film: 'hmenvQhUmxM', flat: 'pIF7l5_hgxg',
  'hand-drawn': 'tthdwfNPCcw', icons: 'FkTvWj0W5bo', 'illustration-wallpapers': 'If65AuNOOxQ',
  'line-art': 'rNbj3NBAY_w', nature: '6sMVjTLSkeQ', patterns: 'upmleWZC83Y',
  people: 'towJZFskpGg', 'street-photography': 'xHxYTMHLgOc',
  'textures-patterns': 'iUIsnVtjB0Y', travel: 'Fzo3zuOHN6w', wallpapers: 'bo8jQKTaE0Y',
};

export const LIMITS = { MAX_DIM: 8000, MIN_DPR: 1, MAX_DPR: 3, MAX_QUERY: 200, MAX_LIST: 10 };
const FITS = ['clamp', 'clip', 'crop', 'scale'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const FALSE_VALUES = ['false', '0', 'no', 'off'];

const bad = (message) => ({ error: { status: 400, message } });

function parseDim(value, name) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (!/^\d{1,5}$/.test(String(value).trim())) return bad(`Invalid ${name}`);
  const n = parseInt(value, 10);
  if (n < 1 || n > LIMITS.MAX_DIM) return bad(`${name} must be between 1 and ${LIMITS.MAX_DIM}`);
  return { value: n };
}

function parseDpr(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < LIMITS.MIN_DPR || n > LIMITS.MAX_DPR) {
    return bad(`dpr must be between ${LIMITS.MIN_DPR} and ${LIMITS.MAX_DPR}`);
  }
  return { value: Math.round(n * 100) / 100 };
}

function parseIdList(raw, name, map) {
  if (!raw) return { value: [] };
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length > LIMITS.MAX_LIST) return bad(`Too many ${name}`);
  const ids = [];
  for (const item of items) {
    const resolved = map ? map[item.toLowerCase()] || item : item;
    if (!ID_RE.test(resolved)) return bad(`Invalid ${name} value`);
    ids.push(resolved);
  }
  return { value: [...new Set(ids)].sort() };
}

export function resolveOrientation(raw, width, height) {
  if (raw === 'auto') {
    if (!width || !height) return null;
    return width > height ? 'landscape' : width < height ? 'portrait' : 'squarish';
  }
  return ['landscape', 'portrait', 'squarish'].includes(raw) ? raw : null;
}

/**
 * @returns {{error}|{selection, render, autosize, label}}
 */
export function parseRequest(url, headers = new Headers()) {
  const q = url.searchParams;
  const autosize = ['headers', 'html'].includes(q.get('autosize')) ? q.get('autosize') : null;

  let w = parseDim(q.get('w') ?? q.get('width'), 'width');
  if (w.error) return w;
  let h = parseDim(q.get('h') ?? q.get('height'), 'height');
  if (h.error) return h;
  let dpr = parseDpr(q.get('dpr'));
  if (dpr.error) return dpr;
  let fit = FITS.includes(q.get('fit')) ? q.get('fit') : 'clip';

  if (autosize === 'headers') {
    const vw = parseInt(headers.get('Sec-CH-Viewport-Width') ?? '', 10);
    const vh = parseInt(headers.get('Sec-CH-Viewport-Height') ?? '', 10);
    if (vw >= 1 && vw <= LIMITS.MAX_DIM && vh >= 1 && vh <= LIMITS.MAX_DIM) {
      w = { value: vw };
      h = { value: vh };
      fit = 'scale';
      const hd = parseDpr(headers.get('Sec-CH-DPR'));
      if (hd.value) dpr = hd;
    }
  }

  const rawCollections = q.get('collections')?.trim() || null;
  const rawTopics = q.get('topics')?.trim() || null;
  let query = (q.get('query') || '').replace(/\s+/g, ' ').trim() || null;
  if ((rawCollections || rawTopics) && query) {
    return bad('Cannot use collections/topics with query parameter');
  }
  if (query && query.length > LIMITS.MAX_QUERY) return bad('query too long');

  const collections = parseIdList(rawCollections, 'collections');
  if (collections.error) return collections;
  const topics = parseIdList(rawTopics, 'topics', TOPIC_SLUG_TO_ID);
  if (topics.error) return topics;

  const selection = {
    collections: collections.value,
    topics: topics.value,
    query,
    orientation: resolveOrientation(q.get('orientation'), w.value, h.value),
  };
  const render = {
    w: w.value,
    h: h.value,
    dpr: dpr.value ?? 2,
    fit,
    enhance: !FALSE_VALUES.includes((q.get('enhance') || '').toLowerCase()),
    q: 65,
    cs: 'srgb',
  };
  const label = rawTopics ? `topics: ${rawTopics}` : query ? `query: ${query}` : rawCollections ? `collections: ${rawCollections}` : 'random';
  return { selection, render, autosize, label };
}

/** Validate a selection received over an internal boundary (broker). */
export function normalizeSelection(input = {}) {
  const list = (v, name) => {
    if (v === undefined || v === null) return { value: [] };
    if (!Array.isArray(v) || v.length > LIMITS.MAX_LIST || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) return bad(`Invalid ${name}`);
    return { value: [...new Set(v)].sort() };
  };
  const c = list(input.collections, 'collections');
  if (c.error) return c;
  const t = list(input.topics, 'topics');
  if (t.error) return t;
  let query = typeof input.query === 'string' ? input.query.replace(/\s+/g, ' ').trim() : null;
  if (query === '') query = null;
  if (query && (query.length > LIMITS.MAX_QUERY || c.value.length || t.value.length)) return bad('Invalid query');
  const orientation = ['landscape', 'portrait', 'squarish'].includes(input.orientation) ? input.orientation : null;
  return { selection: { collections: c.value, topics: t.value, query, orientation } };
}

async function digest(value) {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const selectionKey = async (s) => `s2_${await digest(['sel', 1, s.collections, s.topics, s.query, s.orientation])}`;
export const renderKey = async (r) => `r2_${await digest(['render', 1, r.w, r.h, r.dpr, r.fit, r.enhance, r.q, r.cs])}`;
export const objectKey = (rKey, photoId) => `v2/r/${rKey}/${photoId}`;

export function optimizedUrl(rawUrl, render) {
  const url = new URL(rawUrl);
  url.searchParams.set('auto', render.enhance ? 'format,enhance' : 'format');
  url.searchParams.set('q', String(render.q ?? 65));
  url.searchParams.set('cs', render.cs ?? 'srgb');
  url.searchParams.set('dpr', String(render.dpr ?? 2));
  url.searchParams.set('fit', render.fit ?? 'clip');
  if (render.w) url.searchParams.set('w', String(render.w));
  if (render.h) url.searchParams.set('h', String(render.h));
  return url.toString();
}

export function discoveryParams(selection, count) {
  const p = new URLSearchParams({ count: String(count) });
  if (selection.orientation) p.set('orientation', selection.orientation);
  if (selection.collections.length) p.set('collections', selection.collections.join(','));
  if (selection.topics.length) p.set('topics', selection.topics.join(','));
  if (selection.query) p.set('query', selection.query);
  return p;
}
