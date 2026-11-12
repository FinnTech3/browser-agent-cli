// Element refs look like e1, e2, ... and are numbered per session, never reused.

import { BacError, usageError } from './errors.js';

export function parseRef(input) {
  const m = /^e([1-9][0-9]{0,8})$/.exec(String(input ?? '').trim().toLowerCase());
  return m ? Number(m[1]) : null;
}

export function requireRef(input) {
  if (parseRef(input) === null) {
    throw usageError(`"${String(input ?? '').slice(0, 30)}" is not an element ref. Refs look like e12 and come from: bac look`);
  }
  return String(input).trim().toLowerCase();
}

// Decide why a ref could not be used.
//   issued    highest ref number handed out in this session
//   status    'ok' | 'missing' (not in the page registry) | 'detached' (element removed)
// Returns null when the ref is usable.
export function refProblem(ref, issued, status) {
  if (status === 'ok') return null;
  const n = parseRef(ref);
  if (n === null) return new BacError('usage', `"${ref}" is not an element ref`);
  if (n > issued) {
    return new BacError('unknown_ref', `ref ${ref} was never issued. Run: bac look, then use a ref from its output`);
  }
  if (status === 'detached') {
    return new BacError('stale_ref', `ref ${ref} is stale: its element was removed from the page. Run: bac look`);
  }
  return new BacError(
    'stale_ref',
    `ref ${ref} is stale: the page changed, or the ref belongs to another tab. Run: bac look`,
  );
}
