// HTTP/cron handlers. No cloudflare:workers imports so they can run under Node tests.
import { loadConfig } from './config.js';
import { CLIENT_HINTS, baseHeaders, encodeHeaderValue, setSafeHeader } from './headers.js';
import { objectKey, optimizedUrl, parseRequest, renderKey, selectionKey } from './params.js';

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Not Found</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111;
      color: #888;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .container { text-align: center; }
    h1 { font-size: 6rem; color: #333; margin-bottom: 1rem; }
    p { font-size: 1.2rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>404</h1>
    <p>The requested resource could not be found.</p>
  </div>
</body>
</html>`;

// Only useful when navigated to as a page; scripts do not run when the response is
// consumed as a CSS background / <img>.
const AUTOSIZE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body{margin:0;background:#111;min-height:100vh;}</style>
</head>
<body>
  <script>
    const url = new URL(location.href);
    url.searchParams.delete('autosize');
    url.searchParams.set('w', innerWidth);
    url.searchParams.set('h', innerHeight);
    url.searchParams.set('dpr', devicePixelRatio || 1);
    location.replace(url);
  </script>
</body>
</html>`;

const text = (body, status, extra = {}) => new Response(body, { status, headers: extra });
const SNAP = (k) => `v2:snap:${k}`;

export function coordinatorStub(env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('main'));
}

function validateBindings(env) {
  if (!env.UNSPLASH_CACHE) return text('R2 bucket not configured', 500);
  if (!env.UNSPLASH_CACHE_METADATA) return text('KV namespace not configured', 500);
  if (!env.COORDINATOR) return text('Coordinator not configured', 500);
  if (!env.UNSPLASH_ACCESS_KEY && !env.UNSPLASH_SECONDARY_ACCESS_KEY) return text('Unsplash API key not configured', 500);
  return null;
}

function errorResponse(r) {
  const retry = String(Math.max(1, Math.min(Number(r.retryAfter) || 60, 86400)));
  if (r.code === 'rate_limited') return text('Rate limit exceeded. Please try again later.', 503, { 'Retry-After': retry });
  if (r.code === 'forbidden') return text('Access forbidden. Check status of Unsplash API keys', 403);
  if (r.code === 'empty') return text('No images available', 502);
  return text(`Bad Gateway: ${r.message || r.code}`, 502, { 'Retry-After': retry });
}

function decorate(headers, photo, parsed, status) {
  headers.set('X-Cache-Status', status);
  setSafeHeader(headers, 'X-Unsplash-Photographer', photo.name || '');
  setSafeHeader(headers, 'X-Unsplash-Parameters', parsed.label);
  headers.set('X-Image-Requested-Dimensions', parsed.render.w && parsed.render.h ? `${parsed.render.w}x${parsed.render.h}` : 'auto');
  headers.set('X-Image-Source-URL', `https://unsplash.com/photos/${encodeURIComponent(photo.id)}`);
  if (photo.app) headers.set('X-Unsplash-Application', String(photo.app));
}

async function deliver(env, photo, parsed, rKey) {
  let object = null;
  try {
    object = await env.UNSPLASH_CACHE.get(objectKey(rKey, photo.id));
  } catch (error) {
    console.error('R2 read error:', String(error));
  }
  const headers = baseHeaders();
  if (object) {
    decorate(headers, photo, parsed, 'HIT');
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('X-Image-File-Size', `${((object.size || 0) / 1024 / 1024).toFixed(2)} MB`);
    console.log('CACHE HIT', JSON.stringify({ photo: photo.id, app: photo.app, size: object.size }));
    return { response: new Response(object.body, { status: 200, headers }), hit: true };
  }
  decorate(headers, photo, parsed, 'MISS');
  headers.set('Location', optimizedUrl(photo.raw, parsed.render));
  console.log('CACHE MISS', JSON.stringify({ photo: photo.id, app: photo.app }));
  return { response: new Response(null, { status: 302, headers }), hit: false };
}

async function materialize(env, stub, res, parsed, rKey, servedHit, cfg) {
  const queue = res.plan.slice();
  const results = [];
  const run = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const key = objectKey(rKey, p.id);
      const entry = { renderKey: rKey, photoId: p.id, ok: false };
      results.push(entry);
      try {
        if (servedHit && p.id === res.photo.id) { entry.ok = true; continue; }
        if (await env.UNSPLASH_CACHE.head(key)) { entry.ok = true; continue; }
        const response = await (env.__fetch || fetch)(optimizedUrl(p.raw, parsed.render), { signal: AbortSignal.timeout(cfg.IMAGE_TIMEOUT_MS) });
        const type = response.headers.get('Content-Type');
        if (!response.ok || !type || !type.startsWith('image/')) { await response.body?.cancel(); continue; }
        const body = response.headers.get('Content-Length') ? response.body : await response.arrayBuffer();
        await env.UNSPLASH_CACHE.put(key, body, {
          httpMetadata: { contentType: type },
          customMetadata: { photo: p.id, render: rKey, schema: '2' },
        });
        entry.ok = true;
      } catch (error) {
        console.error('Materialize error:', p.id, String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.MATERIALIZE_CONCURRENCY, queue.length) }, run));
  try { await stub.finishMaterialize(results); } catch (e) { console.error('finishMaterialize', String(e)); }
}

async function fallbackFromSnapshot(env, selKey) {
  try {
    const snap = await env.UNSPLASH_CACHE_METADATA.get(SNAP(selKey), 'json');
    if (snap?.photos?.length) return snap.photos[Math.floor(Math.random() * snap.photos.length)];
  } catch (error) {
    console.error('KV snapshot read error:', String(error));
  }
  return null;
}

async function handleStatus(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response(null, { status: 404 });
  const status = await coordinatorStub(env).status();
  return new Response(JSON.stringify({ now: Date.now(), ...status }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function handleFetch(request, env, ctx) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/__status') return await handleStatus(request, env);
    if (url.pathname !== '/') return new Response(null, { status: 404 });
    if (url.searchParams.get('auth') !== 'true') {
      return text(NOT_FOUND_HTML, 404, { 'Content-Type': 'text/html' });
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: baseHeaders({ Allow: 'GET, HEAD', 'X-Cache-Status': 'NONE' }) });
    }
    if (request.method !== 'GET') return text('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
    if (url.searchParams.get('autosize') === 'html') {
      return text(AUTOSIZE_HTML, 200, { 'Content-Type': 'text/html' });
    }
    const bindingError = validateBindings(env);
    if (bindingError) return bindingError;

    const parsed = parseRequest(url, request.headers);
    if (parsed.error) return text(parsed.error.message, parsed.error.status);
    const cfg = loadConfig(env);
    const [selKey, rKey] = await Promise.all([selectionKey(parsed.selection), renderKey(parsed.render)]);
    const stub = coordinatorStub(env);

    let res;
    try {
      res = await stub.acquire({ selKey, selection: parsed.selection, renderKey: rKey, render: parsed.render });
    } catch (error) {
      console.error('Coordinator error:', String(error));
      res = { ok: false, code: 'coordinator', retryAfter: 30, message: 'coordinator unavailable' };
    }
    if (!res.ok) {
      const photo = await fallbackFromSnapshot(env, selKey);
      if (!photo) return errorResponse(res);
      return (await deliver(env, photo, parsed, rKey)).response;
    }
    const { response, hit } = await deliver(env, res.photo, parsed, rKey);
    const background = [];
    if (res.plan.length) background.push(materialize(env, stub, res, parsed, rKey, hit, cfg));
    if (res.refreshDue) background.push(stub.refresh(selKey));
    background.push(stub.drain());
    ctx.waitUntil(Promise.allSettled(background).then((all) => all.forEach((r) => r.status === 'rejected' && console.error('Background error:', String(r.reason)))));
    return response;
  } catch (error) {
    console.error('Worker error:', String(error));
    return new Response('Internal Server Error', { status: 500 });
  }
}

// ---- Legacy (pre-schema-2) KV entries: age out, only objects they reference ----
export async function cleanupLegacy(env, cfg, budget = 200) {
  const now = Date.now();
  const summary = { checked: 0, deletedKeys: 0, r2Deleted: 0, errors: 0 };
  let cursor;
  for (let more = true; more && budget > 0;) {
    const page = await env.UNSPLASH_CACHE_METADATA.list({ cursor });
    for (const key of page.keys) {
      if (key.name.startsWith('v2:')) continue;
      summary.checked += 1;
      const meta = await env.UNSPLASH_CACHE_METADATA.get(key.name, 'json').catch(() => null);
      if (!meta) continue;
      if (!meta.last_accessed) {
        meta.last_accessed = now;
        await env.UNSPLASH_CACHE_METADATA.put(key.name, JSON.stringify(meta));
        continue;
      }
      if (now - meta.last_accessed <= cfg.LEGACY_IDLE_MS) continue;
      let failed = false;
      for (const image of Array.isArray(meta.images) ? meta.images : []) {
        if (budget <= 0) { failed = true; break; }
        if (!image?.r2_key || image.r2_key.startsWith('v2/')) continue;
        budget -= 1;
        try { await env.UNSPLASH_CACHE.delete(image.r2_key); summary.r2Deleted += 1; } catch { failed = true; summary.errors += 1; }
      }
      if (!failed) { await env.UNSPLASH_CACHE_METADATA.delete(key.name); summary.deletedKeys += 1; }
    }
    more = !page.list_complete;
    cursor = page.cursor;
  }
  return summary;
}

export async function handleScheduled(event, env, ctx) {
  const cfg = loadConfig(env);
  const at = new Date(event.scheduledTime);
  const full = at.getUTCHours() === 2 && at.getUTCMinutes() < 10; // daily deep maintenance window
  console.log('SCHEDULED', event.cron, new Date(event.scheduledTime).toISOString());
  const work = (async () => {
    const stub = coordinatorStub(env);
    console.log('MAINTENANCE', JSON.stringify(await stub.maintenance({ full })));
    if (full) console.log('LEGACY CLEANUP', JSON.stringify(await cleanupLegacy(env, cfg)));
  })().catch((error) => console.error('Scheduled error:', String(error)));
  ctx.waitUntil(work);
}

export function createApp() {
  return { fetch: handleFetch, scheduled: handleScheduled };
}

export { CLIENT_HINTS, encodeHeaderValue };
