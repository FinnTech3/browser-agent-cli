// Matching requested option names against the options of a <select>.

import { BacError } from './errors.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// options: [{ label, value, disabled }]. wanted: array of strings.
// Returns the option indexes to select. Order of preference per wanted entry:
// exact label, exact value, case-insensitive label, case-insensitive value.
export function matchOptions(options, wanted, ref = 'the select') {
  const picked = [];
  for (const want of wanted) {
    const w = norm(want);
    const wl = w.toLowerCase();
    const tests = [
      (o) => norm(o.label) === w,
      (o) => norm(o.value) === w,
      (o) => norm(o.label).toLowerCase() === wl,
      (o) => norm(o.value).toLowerCase() === wl,
    ];
    let index = -1;
    for (const test of tests) {
      index = options.findIndex((o) => !o.disabled && test(o));
      if (index !== -1) break;
    }
    if (index === -1) {
      throw new BacError(
        'option_not_found',
        `no enabled option matching "${norm(want).slice(0, 60)}" in ${ref} (${options.length} options). Run: bac look to see them`,
      );
    }
    if (!picked.includes(index)) picked.push(index);
  }
  return picked;
}
