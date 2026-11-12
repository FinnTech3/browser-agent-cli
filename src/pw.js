// Load Playwright through the CommonJS resolver so it is found both in a normal
// node_modules tree and in setups that provide it through NODE_PATH.

import { createRequire } from 'node:module';

let cached;

export function loadPlaywright() {
  if (!cached) {
    const require = createRequire(import.meta.url);
    cached = require('playwright');
  }
  return cached;
}
