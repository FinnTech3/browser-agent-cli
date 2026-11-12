import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef, refProblem, requireRef } from '../src/refs.js';
import { matchOptions } from '../src/options.js';
import { EXIT, exitCodeFor, toBacError, BacError, ERROR_CODES } from '../src/errors.js';

describe('refs', () => {
  it('parses refs', () => {
    assert.equal(parseRef('e1'), 1);
    assert.equal(parseRef(' E42 '), 42);
    for (const bad of ['e0', 'e', 'x1', 'e01', 'e1.5', '1', '', undefined, 'e-3', 'e1234567890']) {
      assert.equal(parseRef(bad), null, String(bad));
    }
  });

  it('requireRef normalises or throws a usage error', () => {
    assert.equal(requireRef(' E7'), 'e7');
    assert.throws(() => requireRef('button'), (e) => e.code === 'usage');
  });

  it('classifies ref problems', () => {
    assert.equal(refProblem('e3', 10, 'ok'), null);
    assert.equal(refProblem('e11', 10, 'missing').code, 'unknown_ref');
    assert.equal(refProblem('e3', 10, 'missing').code, 'stale_ref');
    assert.equal(refProblem('e3', 10, 'detached').code, 'stale_ref');
    assert.match(refProblem('e3', 10, 'detached').message, /removed from the page/);
    assert.match(refProblem('e3', 10, 'missing').message, /Run: bac look/);
  });
});

describe('matchOptions', () => {
  const options = [
    { label: 'Free', value: 'free' },
    { label: 'Pro plan', value: 'pro' },
    { label: 'Team', value: 'team', disabled: true },
    { label: 'Other', value: 'misc' },
  ];

  it('prefers exact label, then value, then case-insensitive', () => {
    assert.deepEqual(matchOptions(options, ['Pro plan']), [1]);
    assert.deepEqual(matchOptions(options, ['pro']), [1]);
    assert.deepEqual(matchOptions(options, ['FREE']), [0]);
    assert.deepEqual(matchOptions(options, ['  other  ']), [3]);
  });

  it('supports several choices without duplicates', () => {
    assert.deepEqual(matchOptions(options, ['Free', 'free', 'Other']), [0, 3]);
  });

  it('does not select disabled options and reports a clear error', () => {
    assert.throws(
      () => matchOptions(options, ['Team'], 'e4'),
      (e) => e.code === 'option_not_found' && /e4/.test(e.message) && /bac look/.test(e.message),
    );
  });
});

describe('errors', () => {
  it('maps every code to a stable exit code', () => {
    assert.equal(exitCodeFor('stale_ref'), EXIT.ref);
    assert.equal(exitCodeFor('unknown_ref'), EXIT.ref);
    assert.equal(exitCodeFor('timeout'), EXIT.timeout);
    assert.equal(exitCodeFor('blocked_url'), EXIT.blocked);
    assert.equal(exitCodeFor('not_visible'), EXIT.element);
    assert.equal(exitCodeFor('nav_failed'), EXIT.navigation);
    assert.equal(exitCodeFor('browser_lost'), EXIT.session);
    assert.equal(exitCodeFor('usage'), EXIT.usage);
    assert.equal(exitCodeFor('nonsense'), EXIT.internal);
    for (const code of ERROR_CODES) assert.notEqual(exitCodeFor(code), 0, code);
  });

  it('wraps unknown errors without leaking stacks', () => {
    const err = toBacError(new Error('boom\n    at somewhere'));
    assert.ok(err instanceof BacError);
    assert.equal(err.code, 'internal');
    assert.ok(!err.message.includes('\n'));
  });
});
