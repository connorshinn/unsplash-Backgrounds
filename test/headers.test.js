import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeaderValue, setSafeHeader } from '../src/headers.js';

test('plain ASCII passes through; non-Latin and % are percent-encoded and flagged', () => {
  assert.deepEqual(encodeHeaderValue('Ada Lovelace'), { value: 'Ada Lovelace', encoded: false });
  const e = encodeHeaderValue('张伟 ✓');
  assert.equal(e.encoded, true);
  assert.equal(decodeURIComponent(e.value), '张伟 ✓');
  assert.equal(encodeHeaderValue('100% pure').encoded, true);
  assert.equal(encodeHeaderValue('a\r\nX-Injected: 1').encoded, true);
  const h = new Headers();
  setSafeHeader(h, 'X-Unsplash-Photographer', '张伟');
  assert.equal(h.get('X-Unsplash-Photographer-Encoding'), 'percent');
});
