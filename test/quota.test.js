import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { QuotaState } from '../src/quota.js';

const apps = [{ id: 'A' }, { id: 'B' }];
const T0 = 1_000_000;
const mk = (over = {}) => new QuotaState(apps, { ...DEFAULTS, ...over });
const ok = (rem) => ({ status: 200, remaining: rem, limit: 50 });

test('prefers primary while it has capacity', () => {
  const q = mk();
  assert.equal(q.reserve('prod', 'discovery', T0).appId, 'A');
});

test('switches to secondary when primary falls to the tracking reserve; sticky until reset', () => {
  const q = mk();
  const r = q.reserve('prod', 'discovery', T0);
  q.settle(r, ok(DEFAULTS.TRACK_RESERVE), T0);
  assert.equal(q.reserve('prod', 'discovery', T0 + 1000).appId, 'B');
  const t = q.reserve('prod', 'track', T0 + 1000, { appId: 'A' });
  assert.equal(t.ok, true); // reserve is kept for tracking on the owning app
  // still sticky on B even if A looked healthy; no oscillation within the window
  q.settle(t, ok(40), T0 + 1500);
  assert.equal(q.reserve('prod', 'discovery', T0 + 2000).appId, 'B');
  // after the window resets, primary is preferred again
  assert.equal(q.reserve('prod', 'discovery', T0 + 3600001).appId, 'A');
});

test('429 honours Retry-After and fails over; both exhausted denies with the soonest recovery', () => {
  const q = mk();
  let r = q.reserve('prod', 'discovery', T0);
  assert.equal(q.settle(r, { status: 429, retryAfter: 120 }, T0).class, 'quota');
  r = q.reserve('prod', 'discovery', T0 + 1);
  assert.equal(r.appId, 'B');
  q.settle(r, { status: 403, body: 'Rate Limit Exceeded' }, T0 + 1);
  const d = q.reserve('prod', 'discovery', T0 + 2);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'exhausted');
  assert.ok(d.retryAfterMs > 100000 && d.retryAfterMs <= 3600000);
  // A recovers after its Retry-After
  assert.equal(q.reserve('prod', 'discovery', T0 + 121000).appId, 'A');
});

test('missing Retry-After uses bounded exponential cooldown', () => {
  const q = mk();
  for (let i = 0; i < 6; i += 1) {
    const r = q.reserve('prod', 'track', T0 + i * 4000000, { appId: 'A' });
    assert.ok(r.ok);
    q.settle(r, { status: 429 }, T0 + i * 4000000);
    assert.ok(q.apps.A.cooldownUntil - (T0 + i * 4000000) <= 3600000);
  }
});

test('invalid credentials are not treated as quota exhaustion', () => {
  const q = mk();
  let r = q.reserve('prod', 'discovery', T0);
  assert.equal(q.settle(r, { status: 401 }, T0).class, 'invalid');
  r = q.reserve('prod', 'discovery', T0);
  assert.equal(r.appId, 'B');
  assert.equal(q.settle(r, { status: 403, body: 'forbidden app' }, T0).class, 'invalid');
  const d = q.reserve('prod', 'discovery', T0 + 1);
  assert.equal(d.reason, 'invalid');
});

test('concurrent reservations cannot overshoot remaining budget', () => {
  const q = mk();
  q.apps.A.remaining = DEFAULTS.TRACK_RESERVE + 2; // two discoveries fit above the reserve
  const rs = [1, 2, 3, 4].map(() => q.reserve('prod', 'discovery', T0));
  assert.deepEqual(rs.map((r) => r.appId), ['A', 'A', 'B', 'B']);
  q.cancel(rs[0]);
  assert.equal(q.apps.A.inflight, 1);
});

test('pilot: allowance across both keys incl. tracking, production reserve, priority', () => {
  const q = mk({ PILOT_HOURLY_ALLOWANCE: 3 });
  const taken = [];
  for (let i = 0; i < 3; i += 1) {
    const r = q.reserve('pilot', i === 2 ? 'track' : 'discovery', T0 + i, i === 2 ? { appId: 'A' } : {});
    assert.ok(r.ok, `pilot call ${i}`);
    taken.push(r);
  }
  const denied = q.reserve('pilot', 'discovery', T0 + 10);
  assert.equal(denied.reason, 'pilot_allowance');
  taken.forEach((r) => q.settle(r, ok(30), T0 + 20));
  assert.equal(q.reserve('pilot', 'discovery', T0 + 3600001).ok, true); // window rolled
  // production still has the whole remaining budget regardless of pilot activity
  assert.equal(q.reserve('prod', 'discovery', T0 + 30).ok, true);
});

test('pilot cannot touch the production reserve of an application', () => {
  const q = mk();
  q.apps.A.remaining = DEFAULTS.PILOT_PROD_RESERVE;
  q.apps.B.remaining = DEFAULTS.PILOT_PROD_RESERVE;
  assert.equal(q.reserve('pilot', 'discovery', T0).ok, false);
  assert.equal(q.reserve('prod', 'discovery', T0).appId, 'A');
});

test('snapshot survives restart without carrying in-flight counts', () => {
  const q = mk();
  const r = q.reserve('prod', 'discovery', T0);
  q.settle(r, { status: 429, retryAfter: 600 }, T0);
  const q2 = new QuotaState(apps, DEFAULTS, q.snapshot());
  assert.ok(q2.apps.A.cooldownUntil > T0);
  assert.equal(q2.apps.A.inflight, 0);
});
