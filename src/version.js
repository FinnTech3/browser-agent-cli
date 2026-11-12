import fs from 'node:fs';

// Bumped whenever the client/daemon wire format changes.
export const PROTOCOL = 1;

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
