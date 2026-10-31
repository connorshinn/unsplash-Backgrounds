// Safe HTTP header values. Header values must be printable ASCII; anything else
// is percent-encoded (decode with decodeURIComponent) and flagged.
export function encodeHeaderValue(value, max = 200) {
  const text = String(value ?? '').slice(0, max);
  const plain = /^[\x20-\x7e]*$/.test(text) && !text.includes('%');
  return plain ? { value: text, encoded: false } : { value: encodeURIComponent(text), encoded: true };
}

export function setSafeHeader(headers, name, value, max) {
  const { value: v, encoded } = encodeHeaderValue(value, max);
  headers.set(name, v);
  if (encoded) headers.set(`${name}-Encoding`, 'percent');
}

export const CLIENT_HINTS = {
  'Accept-CH': 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height, Sec-CH-DPR',
  'Critical-CH': 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height',
};

export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

export function baseHeaders(extra = {}) {
  return new Headers({ ...NO_STORE, ...CLIENT_HINTS, ...extra });
}
