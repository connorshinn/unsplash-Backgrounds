import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, renderKey, selectionKey, objectKey, optimizedUrl, discoveryParams, normalizeSelection } from '../src/params.js';

const parse = (qs, headers) => parseRequest(new URL(`https://x/?${qs}`), new Headers(headers));

test('production URL maps to the same discovery query as before', () => {
  const p = parse('auth=true&topics=nature&w=3840&h=1910&orientation=landscape');
  assert.deepEqual(p.selection, { collections: [], topics: ['6sMVjTLSkeQ'], query: null, orientation: 'landscape' });
  assert.equal(discoveryParams(p.selection, 30).toString(), 'count=30&orientation=landscape&topics=6sMVjTLSkeQ');
  assert.equal(p.render.dpr, 2);
  assert.equal(p.render.fit, 'clip');
  assert.equal(p.render.enhance, true);
});

test('different sizes share selection but not rendering', async () => {
  const a = parse('topics=nature&w=3840&h=1910&orientation=landscape');
  const b = parse('topics=nature&w=1920&h=1080&orientation=landscape');
  assert.equal(await selectionKey(a.selection), await selectionKey(b.selection));
  assert.notEqual(await renderKey(a.render), await renderKey(b.render));
});

test('DPR, fit, enhance and orientation round-trip into keys', async () => {
  const base = parse('w=100&h=50');
  for (const qs of ['w=100&h=50&dpr=1', 'w=100&h=50&fit=crop', 'w=100&h=50&enhance=false']) {
    assert.notEqual(await renderKey(parse(qs).render), await renderKey(base.render), qs);
  }
  assert.equal(parse('w=100&h=50&dpr=1.5').render.dpr, 1.5);
  assert.equal(parse('enhance=false').render.enhance, false);
  assert.equal(parse('enhance=0').render.enhance, false);
  assert.equal(parse('enhance=true').render.enhance, true);
  assert.notEqual(await selectionKey(parse('orientation=portrait').selection), await selectionKey(parse('orientation=landscape').selection));
});

test('orientation=auto resolves before pool selection', async () => {
  assert.equal(parse('orientation=auto&w=100&h=200').selection.orientation, 'portrait');
  assert.equal(parse('orientation=auto&w=300&h=200').selection.orientation, 'landscape');
  assert.equal(parse('orientation=auto&w=200&h=200').selection.orientation, 'squarish');
  assert.equal(parse('orientation=auto').selection.orientation, null);
  assert.equal(await selectionKey(parse('orientation=auto&w=300&h=200').selection), await selectionKey(parse('orientation=landscape').selection));
});

test('aliases and equivalent forms share keys; query text is not reordered', async () => {
  assert.equal(await selectionKey(parse('topics=Nature').selection), await selectionKey(parse('topics=6sMVjTLSkeQ').selection));
  assert.equal(await selectionKey(parse('topics=nature,animals').selection), await selectionKey(parse('topics=animals,nature').selection));
  assert.equal(await renderKey(parse('width=10&height=20').render), await renderKey(parse('w=10&h=20').render));
  assert.equal(parse('query=dark%20%20forest,%20fog').selection.query, 'dark forest, fog');
  assert.notEqual(await selectionKey(parse('query=b,a').selection), await selectionKey(parse('query=a,b').selection));
});

test('delimiter-bearing input cannot collide or smuggle values', async () => {
  assert.ok(parse('topics=a%26orientation%3Dlandscape').error);
  assert.ok(parse('collections=1%2C2%3Dx').error);
  const q1 = await selectionKey(parse('query=a%26b').selection);
  const q2 = await selectionKey(parse('query=a&b').selection);
  assert.equal(q1 !== q2, true);
});

test('bounds and conflicts', () => {
  assert.equal(parse('w=0').error.status, 400);
  assert.equal(parse('w=99999').error.status, 400);
  assert.equal(parse('w=abc').error.status, 400);
  assert.equal(parse('dpr=9').error.status, 400);
  assert.equal(parse('topics=nature&query=x').error.status, 400);
  assert.equal(parse('query=' + 'a'.repeat(300)).error.status, 400);
  assert.equal(parse('fit=bogus').render.fit, 'clip');
});

test('autosize=headers uses client hints incl. DPR', () => {
  const p = parse('autosize=headers', { 'Sec-CH-Viewport-Width': '1440', 'Sec-CH-Viewport-Height': '900', 'Sec-CH-DPR': '2' });
  assert.deepEqual([p.render.w, p.render.h, p.render.dpr, p.render.fit], [1440, 900, 2, 'scale']);
  const q = parse('autosize=headers', { 'Sec-CH-Viewport-Width': 'junk' });
  assert.equal(q.render.w, null);
});

test('optimized URL preserves ixid and applies render settings', () => {
  const u = new URL(optimizedUrl('https://images.unsplash.com/p?ixid=abc&ixlib=rb', parse('w=3840&h=1910&dpr=2&enhance=false&fit=crop').render));
  assert.equal(u.searchParams.get('ixid'), 'abc');
  assert.deepEqual([u.searchParams.get('auto'), u.searchParams.get('q'), u.searchParams.get('cs'), u.searchParams.get('dpr'), u.searchParams.get('fit'), u.searchParams.get('w'), u.searchParams.get('h')],
    ['format', '65', 'srgb', '2', 'crop', '3840', '1910']);
  assert.match(objectKey('r2_x', 'p1'), /^v2\/r\/r2_x\/p1$/);
});

test('broker selection validation', () => {
  assert.ok(normalizeSelection({ topics: ['a&b'] }).error);
  assert.ok(normalizeSelection({ query: 'x', topics: ['abc'] }).error);
  assert.deepEqual(normalizeSelection({ topics: ['b', 'a'], orientation: 'x' }).selection, { collections: [], topics: ['a', 'b'], query: null, orientation: null });
});
