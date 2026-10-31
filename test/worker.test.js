import test from 'node:test';
import assert from 'node:assert/strict';
import { makeUpstream, makeWorld } from './helpers.js';
import { cleanupLegacy } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { objectKey } from '../src/params.js';

const PROD = '/?auth=true&topics=nature&w=3840&h=1910&orientation=landscape';

test('cold request redirects to the CDN, tracks the first photo, and stores upcoming photos', async () => {
  const w = await makeWorld();
  const res = await w.req(PROD);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('X-Cache-Status'), 'MISS');
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.searchParams.get('w'), '3840');
  assert.equal(loc.searchParams.get('dpr'), '2');
  assert.equal(w.up.lastQuery.topics, '6sMVjTLSkeQ');
  assert.equal(w.up.lastQuery.orientation, 'landscape');
  assert.equal(w.up.lastQuery.count, '30');
  await w.core.drain();
  assert.equal(w.up.tracks.length, 1, 'initial redirected photo is tracked');
  assert.equal(w.env.UNSPLASH_CACHE.m.size, 7, 'served + 6 ahead');
  const hit = await w.req(PROD);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('X-Cache-Status'), 'HIT');
  assert.equal(w.up.discoveries, 1);
});

test('a new size reuses the pool: no discovery, redirect then lazy render', async () => {
  const w = await makeWorld();
  await w.req(PROD);
  const r = await w.req('/?auth=true&topics=nature&w=1920&h=1080&orientation=landscape');
  assert.equal(r.status, 302);
  assert.equal(w.up.discoveries, 1);
  assert.ok(w.env.UNSPLASH_CACHE.m.size > 7);
});

test('concurrent cold misses cause a single discovery and distinct photos', async () => {
  const w = await makeWorld();
  const rs = await Promise.all(Array.from({ length: 5 }, () => w.req(PROD)));
  assert.equal(w.up.discoveries, 1);
  const urls = new Set(rs.map((r) => r.headers.get('X-Image-Source-URL')));
  assert.equal(urls.size, 5);
});

test('unicode photographer on a valid R2 hit does not trigger discovery', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ photoName: '张伟 Ünïcode' }) });
  await w.req(PROD);
  const before = w.up.discoveries;
  const r = await w.req(PROD);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Unsplash-Photographer-Encoding'), 'percent');
  assert.equal(decodeURIComponent(r.headers.get('X-Unsplash-Photographer')), '张伟 Ünïcode');
  assert.equal(w.up.discoveries, before);
});

test('R2 read errors fall back to the redirect, not discovery', async () => {
  const w = await makeWorld();
  await w.req(PROD);
  w.env.UNSPLASH_CACHE.failGet = true;
  const r = await w.req(PROD);
  assert.equal(r.status, 302);
  assert.equal(w.up.discoveries, 1);
});

test('R2 store errors leave a usable pool and later requests still redirect', async () => {
  const w = await makeWorld();
  w.env.UNSPLASH_CACHE.failPut = true;
  const a = await w.req(PROD);
  const b = await w.req(PROD);
  assert.deepEqual([a.status, b.status], [302, 302]);
  assert.equal(w.up.discoveries, 1);
  assert.equal(w.core.pools.done.size, 0, 'failed stores are not recorded as materialized');
});

test('HEAD and unsupported methods do not rotate or call Unsplash', async () => {
  const w = await makeWorld();
  assert.equal((await w.req(PROD, { method: 'HEAD' })).status, 200);
  assert.equal((await w.req(PROD, { method: 'POST' })).status, 405);
  assert.equal((await w.req(PROD, { method: 'DELETE' })).status, 405);
  assert.equal(w.up.calls.length, 0);
  assert.equal((await w.store.list({ prefix: 'pool:' })).size, 0);
});

test('request gating and path rules are preserved', async () => {
  const w = await makeWorld();
  assert.equal((await w.req('/?topics=nature')).status, 404);
  assert.equal((await w.req('/robots.txt?auth=true')).status, 404);
  assert.equal((await w.req('/__status')).status, 404);
  assert.equal((await w.req('/?auth=true&autosize=html')).headers.get('Content-Type'), 'text/html');
  assert.equal((await w.req('/?auth=true&topics=nature&query=x')).status, 400);
  assert.equal(w.up.calls.length, 0);
});

test('refresh keeps usable photos, preserves unseen reserve, and rotates by actual pool length', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ perCall: 8 }) });
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    const r = await w.req(PROD);
    assert.ok([200, 302].includes(r.status), `request ${i}`);
    seen.push(r.headers.get('X-Image-Source-URL'));
  }
  assert.ok(w.up.discoveries >= 3 && w.up.discoveries <= 14, `discoveries=${w.up.discoveries}`);
  assert.ok(new Set(seen).size > 16);
});

test('partial and empty batches never create invalid indexes or refill storms', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ perCall: 3 }) });
  for (let i = 0; i < 25; i += 1) assert.ok([200, 302].includes((await w.req(PROD)).status));
  assert.ok(w.up.discoveries < 25, 'refreshes are not per-request');
  const empty = await makeWorld({ upstream: makeUpstream({ perCall: 0 }) });
  assert.equal((await empty.req(PROD)).status, 502);
  assert.equal((await empty.req(PROD)).status, 502);
});

test('refresh failure keeps the old pool and backs off', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ perCall: 8 }) });
  for (let i = 0; i < 4; i += 1) await w.req(PROD);
  w.up.rules.KEY1 = { status: 503 };
  w.up.rules.KEY2 = { status: 503 };
  const before = w.up.discoveries;
  for (let i = 0; i < 20; i += 1) assert.ok([200, 302].includes((await w.req(PROD)).status));
  const attempts = w.up.calls.filter((c) => c.url.includes('/photos/random')).length;
  assert.ok(attempts <= 6, `backoff limited attempts (${attempts})`);
  assert.equal(w.up.discoveries, before);
});

test('replacement image downloads all failing deletes nothing and keeps serving', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ perCall: 8 }) });
  for (let i = 0; i < 6; i += 1) await w.req(PROD);
  const objects = w.env.UNSPLASH_CACHE.m.size;
  w.up.imageStatus = 503;
  for (let i = 0; i < 12; i += 1) assert.ok([200, 302].includes((await w.req(PROD)).status));
  assert.ok(w.env.UNSPLASH_CACHE.m.size >= objects);
  assert.equal(w.env.UNSPLASH_CACHE.deleted.length, 0, 'nothing deleted inside the grace period');
});

test('stale refresh cannot overwrite rotation progress made during discovery', async () => {
  const up = makeUpstream({ perCall: 6 });
  const w = await makeWorld({ upstream: up });
  await w.req(PROD);
  await w.req(PROD);
  const selKey = [...(await w.store.list({ prefix: 'pool:' })).keys()][0].slice(5);
  let release;
  const gate = new Promise((r) => { release = r; });
  const orig = up.fetch;
  let first = true;
  up.fetch = async (...a) => { if (first && String(a[0]).includes('/photos/random')) { first = false; await gate; } return orig(...a); };
  w.core.gateway.fetch = up.fetch;
  const before = await w.store.get(`pool:${selKey}`);
  const old = before.photos;
  const refresh = w.core.refresh(selKey);
  await new Promise((r) => setTimeout(r, 5));
  const during = await w.core.acquire({ selKey, selection: { collections: [], topics: [], query: null, orientation: null }, renderKey: 'r2_x', render: {} });
  release();
  const out = await refresh;
  assert.equal(out.ok, true);
  const pool = await w.store.get(`pool:${selKey}`);
  assert.equal(during.photo.id, old[before.pos].id);
  assert.equal(pool.photos[0].id, old[before.pos + 1].id, 'unseen reserve is preserved at the front, after progress made during discovery');
  assert.ok(!pool.photos.some((p) => p.id === during.photo.id), 'photo served during discovery is not re-queued');
  assert.equal(pool.pos, 0);
  assert.ok(pool.generation >= 2);
  assert.equal(new Set(pool.photos.map((p) => p.id)).size, pool.photos.length);
});

test('gc: deletes only after grace, retains references when delete fails, retries', async () => {
  const w = await makeWorld({ upstream: makeUpstream({ perCall: 6 }) });
  for (let i = 0; i < 6; i += 1) await w.req(PROD);
  const selKey = [...(await w.store.list({ prefix: 'pool:' })).keys()][0].slice(5);
  await w.core.refresh(selKey);
  const gcs = await w.store.list({ prefix: 'gc:' });
  assert.ok(gcs.size >= 1);
  assert.deepEqual((await w.core.pools.runGc()).deleted, 0, 'inside grace');
  w.t.now += 16 * 60 * 1000;
  w.env.UNSPLASH_CACHE.failDelete = true;
  await w.core.pools.runGc();
  assert.ok((await w.store.list({ prefix: 'gc:' })).size >= 1, 'entry retained after failure');
  w.env.UNSPLASH_CACHE.failDelete = false;
  w.t.now += 3 * 3600 * 1000;
  const r = await w.core.pools.runGc();
  assert.ok(r.deleted > 0);
  assert.equal((await w.store.list({ prefix: 'gc:' })).size, 0);
  assert.ok(w.env.UNSPLASH_CACHE.deleted.every((k) => k.startsWith('v2/r/')));
});

test('idle pools are retired and legacy cleanup never touches v2/ keys or live entries', async () => {
  const w = await makeWorld();
  await w.req(PROD);
  w.t.now += 15 * 24 * 3600 * 1000;
  assert.equal((await w.core.pools.sweepIdle()).swept, 1);
  await w.core.pools.runGc();
  assert.equal([...w.env.UNSPLASH_CACHE.m.keys()].filter((k) => k.startsWith('v2/')).length, 0);

  const kv = w.env.UNSPLASH_CACHE_METADATA;
  const old = Date.now() - 20 * 24 * 3600 * 1000;
  await kv.put('legacy-old', JSON.stringify({ last_accessed: old, images: [{ r2_key: 'legacy-old_0' }, { r2_key: 'v2/r/keep/x' }] }));
  await kv.put('legacy-new', JSON.stringify({ last_accessed: Date.now(), images: [{ r2_key: 'legacy-new_0' }] }));
  for (const k of ['legacy-old_0', 'legacy-new_0', 'v2/r/keep/x', 'foreign-object']) w.env.UNSPLASH_CACHE.m.set(k, { body: new ArrayBuffer(1), size: 1 });
  const s = await cleanupLegacy(w.env, loadConfig(w.env));
  assert.equal(s.deletedKeys, 1);
  const left = [...w.env.UNSPLASH_CACHE.m.keys()];
  assert.ok(!left.includes('legacy-old_0'));
  assert.ok(['legacy-new_0', 'v2/r/keep/x', 'foreign-object'].every((k) => left.includes(k)));
});

test('first photo and each use are tracked with the owning application key', async () => {
  const w = await makeWorld();
  w.up.rules.KEY1 = {};
  await w.req(PROD);
  await w.req(PROD);
  await w.core.drain();
  await w.core.drain();
  assert.equal(w.up.tracks.length, 2, 'distinct uses produce distinct events');
  assert.ok(w.up.tracks.every((t) => t.key === 'KEY1'));
  assert.ok(w.up.tracks[0].url.includes('ixid=abc'), 'tracking URL preserved intact');
});

test('failover: secondary discovers when primary is exhausted; primary-owned events are never re-attributed', async () => {
  const w = await makeWorld();
  await w.req(PROD); // pool discovered by the primary application
  w.up.rules.KEY1 = { status: 429, retryAfter: 600 };
  w.up.tracks.length = 0;
  await w.req(PROD); // primary-owned photo used; its event hits the 429 and stays queued
  await w.req(PROD);
  await w.core.drain();
  const r = await w.req('/?auth=true&topics=animals&w=100&h=100');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('X-Unsplash-Application'), '1116485');
  await w.core.drain();
  const pending = [...(await w.core.events.load()).values()];
  assert.ok(pending.some((e) => e.app === '813645'), 'primary-owned events remain queued during its cooldown');
  assert.ok(w.up.tracks.every((t) => t.key === 'KEY2'), 'only secondary-owned events used the secondary key');
  assert.ok(w.up.tracks.length >= 1);
  // after the cooldown the queued primary events are delivered with the primary key
  w.up.rules.KEY1 = {};
  w.t.now += 3600_001;
  w.up.tracks.length = 0;
  await w.core.drain();
  await w.core.drain();
  assert.ok(w.up.tracks.some((t) => t.key === 'KEY1'));
});

test('both applications exhausted: cached photos still served, 503 with Retry-After otherwise', async () => {
  const w = await makeWorld();
  await w.req(PROD);
  w.up.rules.KEY1 = { status: 429, retryAfter: 900 };
  w.up.rules.KEY2 = { status: 429, retryAfter: 1200 };
  assert.equal((await w.req(PROD)).status, 200);
  const miss = await w.req('/?auth=true&topics=travel');
  assert.equal(miss.status, 503);
  assert.ok(Number(miss.headers.get('Retry-After')) >= 800 && Number(miss.headers.get('Retry-After')) <= 1300);
});

test('invalid primary credentials fall over to the secondary; both invalid is 403', async () => {
  const w = await makeWorld();
  w.up.rules.KEY1 = { status: 401 };
  assert.equal((await w.req(PROD)).status, 302);
  assert.equal(w.up.calls.filter((c) => c.key === 'KEY2' && c.url.includes('random')).length, 1);
  const x = await makeWorld();
  x.up.rules.KEY1 = { status: 401 };
  x.up.rules.KEY2 = { status: 401 };
  assert.equal((await x.req(PROD)).status, 403);
});

test('recovery: after the cooldown the primary is used again', async () => {
  const w = await makeWorld();
  await w.req(PROD);
  w.up.rules.KEY1 = { status: 429, retryAfter: 60 };
  await w.req('/?auth=true&topics=animals');
  w.up.rules.KEY1 = {};
  w.t.now += 3600_001;
  const r = await w.req('/?auth=true&topics=travel');
  assert.equal(r.headers.get('X-Unsplash-Application'), '813645');
});

test('concurrent failover: simultaneous cold misses reserve distinct budget safely', async () => {
  const w = await makeWorld();
  w.up.delay = 20;
  w.core.quota.apps['813645'].remaining = 11; // only one discovery above the reserve
  const topics = ['animals', 'travel', 'people'];
  const rs = await Promise.all(topics.map((t) => w.req(`/?auth=true&topics=${t}`)));
  assert.ok(rs.every((r) => r.status === 302));
  const apps = rs.map((r) => r.headers.get('X-Unsplash-Application')).sort();
  assert.deepEqual(apps, ['1116485', '1116485', '813645']);
});

test('broker: consumer identity is fixed, selection validated, pilot allowance enforced, ownership kept', async () => {
  const w = await makeWorld({ env: { PILOT_HOURLY_ALLOWANCE: '2' } });
  const sel = { topics: ['6sMVjTLSkeQ'], orientation: 'landscape' };
  const a = await w.core.brokerDiscover('pilot', { selection: sel, count: 99 });
  assert.equal(a.ok, true);
  assert.equal(w.up.lastQuery.count, '30');
  assert.ok(a.photos.every((p) => p.app === '813645'));
  assert.equal((await w.core.brokerDiscover('pilot', { selection: { topics: ['a b&c'] } })).code, 'bad_request');
  assert.equal((await w.core.brokerTrack('pilot', { id: 'x', app: '813645', dl: 'https://evil.example/photos/x/download' })).ok, false);
  assert.equal((await w.core.brokerTrack('pilot', { id: 'x', app: 'nope', dl: a.photos[0].dl })).ok, false);
  assert.equal((await w.core.brokerTrack('pilot', a.photos[0])).ok, true);
  const blocked = await w.core.brokerDiscover('pilot', { selection: sel });
  assert.equal(blocked.ok, true); // second allowed call
  const denied = await w.core.brokerDiscover('pilot', { selection: sel });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'rate_limited');
  // production is unaffected by pilot allowance exhaustion
  assert.equal((await w.req(PROD)).status, 302);
  // pilot event waits for the next window; production events drain first
  await w.core.drain();
  assert.equal(w.up.tracks.filter((t) => t.url.includes(a.photos[0].id)).length, 0);
});

test('status endpoint needs ADMIN_TOKEN and exposes quota without secrets', async () => {
  const w = await makeWorld({ env: { ADMIN_TOKEN: 'tok' } });
  await w.req(PROD);
  assert.equal((await w.req('/__status')).status, 404);
  const r = await w.req('/__status', { headers: { Authorization: 'Bearer tok' } });
  const body = await r.text();
  assert.ok(body.includes('813645') && body.includes('remaining'));
  assert.ok(!body.includes('KEY1') && !body.includes('KEY2'));
});

test('R2 object key layout is scoped under v2/r/', () => {
  assert.ok(objectKey('r2_a', 'p').startsWith('v2/r/'));
});
