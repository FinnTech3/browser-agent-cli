// URL and domain policy. Pure functions, no I/O, no browser.
//
// Rules:
//   * Only http: and https: URLs can be opened.
//   * URLs with embedded credentials are refused.
//   * An optional allowlist limits which hosts the browser may navigate to.
//     "example.com" allows example.com and every subdomain.
//     "*.example.com" allows subdomains only.

import { BacError, usageError } from './errors.js';

/* eslint-disable-next-line no-control-regex */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// "localhost:3000", "example.com:8080/path" : a host with a port, not a scheme.
const HOST_PORT = /^[^\s/?#:@]+:\d{1,5}(?:[/?#]|$)/;

export function hostKey(hostname) {
  let h = String(hostname).toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export function isLoopbackHost(hostname) {
  const h = hostKey(hostname);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

// Normalise one allowlist entry, or throw a usage error.
export function normalizeDomainEntry(raw) {
  let entry = String(raw).trim().toLowerCase();
  if (!entry) throw usageError('empty domain in allowlist');
  let wildcard = false;
  if (entry.startsWith('*.')) {
    wildcard = true;
    entry = entry.slice(2);
  }
  let parsed;
  try {
    parsed = new URL(`http://${entry}`);
  } catch {
    throw usageError(`invalid domain "${raw}" in allowlist. Use a bare host such as example.com`);
  }
  const bare = hostKey(parsed.hostname);
  if (
    !bare ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw usageError(`invalid domain "${raw}" in allowlist. Use a bare host such as example.com`);
  }
  return wildcard ? `*.${bare}` : bare;
}

// Accepts an array of strings that may themselves be comma separated.
// Returns a sorted, de-duplicated array, or null when no entries were given.
export function parseAllowList(values) {
  if (values === null || values === undefined) return null;
  const list = Array.isArray(values) ? values : [values];
  const out = new Set();
  for (const item of list) {
    for (const piece of String(item).split(',')) {
      if (piece.trim() === '') continue;
      out.add(normalizeDomainEntry(piece));
    }
  }
  return out.size ? [...out].sort() : null;
}

export function sameAllowList(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function hostAllowed(hostname, allow) {
  if (!allow || allow.length === 0) return true;
  const host = hostKey(hostname);
  return allow.some((entry) => {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      return host !== base && host.endsWith(`.${base}`);
    }
    return host === entry || host.endsWith(`.${entry}`);
  });
}

// Turn what a person or agent typed into a candidate absolute URL string.
// Bare hosts such as "example.com" get https://, loopback hosts get http://.
export function normalizeInput(input) {
  const s = String(input ?? '').trim();
  if (!s) throw usageError('missing URL');
  if (CONTROL_CHARS.test(s)) {
    throw new BacError('blocked_url', 'blocked: URL contains control characters');
  }
  if (HOST_PORT.test(s)) return withDefaultScheme(s);
  if (HAS_SCHEME.test(s)) return s;
  return withDefaultScheme(s);
}

function withDefaultScheme(s) {
  const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  return `${isLoopbackHost(host) ? 'http' : 'https'}://${s}`;
}

// Link-local and cloud metadata endpoints hand out credentials to anything on
// the machine. They are refused unless the allowlist names them explicitly.
// Host names that merely resolve to such addresses are not detected.
export function isMetadataHost(hostname) {
  const h = hostKey(hostname);
  if (h === 'metadata.google.internal' || h === 'metadata' || h === '100.100.100.200' || h === '[fd00:ec2::254]') return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^\[fe[89ab][0-9a-f]:/.test(h)) return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(h);
  return !!mapped && Number.parseInt(mapped[1], 16) === 0xa9fe;
}

function describeScheme(protocol) {
  return protocol.length > 20 ? `${protocol.slice(0, 20)}...` : protocol;
}

function domainRefusal(hostname, allow) {
  const shown = hostKey(hostname).replace(/[^\x21-\x7e]/g, '?').slice(0, 80);
  return new BacError(
    'blocked_url',
    `blocked: host "${shown}" is not in the allowed domains (${allow.join(', ')}). Ask the user before widening the list`,
  );
}

// Validate a URL a person or agent asked to open.
// Returns the normalised href or throws BacError('blocked_url' | 'usage').
export function checkUrl(input, allow = null) {
  const candidate = normalizeInput(input);
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw usageError(`"${String(input).slice(0, 80)}" is not a valid URL`);
  }
  assertUrlObject(url, allow);
  return url.href;
}

function assertUrlObject(url, allow) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BacError(
      'blocked_url',
      `blocked: scheme "${describeScheme(url.protocol)}" is not allowed. Only http and https URLs can be opened`,
    );
  }
  if (url.username || url.password) {
    throw new BacError('blocked_url', 'blocked: URLs with embedded credentials are not allowed');
  }
  if (!url.hostname) throw usageError('URL has no host');
  if (isMetadataHost(url.hostname) && !(allow ?? []).includes(hostKey(url.hostname))) {
    throw new BacError(
      'blocked_url',
      'blocked: link-local and cloud metadata addresses are refused. Name the host in --allow-domain only if the user asked for it',
    );
  }
  if (!hostAllowed(url.hostname, allow)) throw domainRefusal(url.hostname, allow);
}

// Check a URL the browser is about to load or has loaded (redirects, popups,
// links the page triggered). about:blank is the only non-http page allowed.
export function checkLoadedUrl(urlString, allow = null) {
  if (urlString === 'about:blank') return { ok: true };
  try {
    assertUrlObject(new URL(urlString), allow);
    return { ok: true };
  } catch (err) {
    if (err instanceof BacError) return { ok: false, error: err };
    return { ok: false, error: new BacError('blocked_url', 'blocked: unparseable URL') };
  }
}
