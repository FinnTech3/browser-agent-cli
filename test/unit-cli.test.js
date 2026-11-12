import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgv } from '../src/args.js';
import { COMMANDS, parseTimeout } from '../src/commands.js';
import { parseDuration, resolveShotPath, validateSessionName, sessionPaths } from '../src/paths.js';
import { main } from '../src/cli.js';

const usage = (fn) => assert.throws(fn, (e) => e.code === 'usage');

describe('argument parsing', () => {
  it('finds the command and positionals', () => {
    const r = parseArgv(['put', 'e2', 'hello world']);
    assert.equal(r.command, 'put');
    assert.deepEqual(r.positionals, ['e2', 'hello world']);
  });

  it('accepts global options before, between and after', () => {
    const r = parseArgv(['--json', 'look', '--timeout=5s', '--actions', '--allow-domain', 'a.test', '--allow-domain=b.test']);
    assert.equal(r.global.json, true);
    assert.equal(r.global.timeout, '5s');
    assert.deepEqual(r.global['allow-domain'], ['a.test', 'b.test']);
    assert.equal(r.flags.actions, true);
  });

  it('treats everything after -- as text, even option-like text', () => {
    const r = parseArgv(['put', 'e1', '--', '--json']);
    assert.deepEqual(r.positionals, ['e1', '--json']);
    assert.equal(r.global.json, undefined);
  });

  it('allows negative numbers as values', () => {
    assert.deepEqual(parseArgv(['put', 'e1', '-5']).positionals, ['e1', '-5']);
  });

  it('reports unknown commands, options and wrong arity', () => {
    usage(() => parseArgv(['frobnicate']));
    usage(() => parseArgv(['look', '--nope']));
    usage(() => parseArgv(['tap']));
    usage(() => parseArgv(['tap', 'e1', 'e2']));
    usage(() => parseArgv(['go', 'http://a.test', '-x']));
    usage(() => parseArgv(['--timeout']));
  });

  it('returns no command for bare options', () => {
    assert.equal(parseArgv(['--help']).command, null);
    assert.equal(parseArgv(['-v']).global.version, true);
  });
});

describe('command builders', () => {
  const io = { cwd: '/work', readStdin: async () => 'from stdin\n' };
  const build = (cmd, pos, flags = {}) => COMMANDS[cmd].build(pos, flags, io);

  it('validate refs', async () => {
    assert.deepEqual((await build('tap', ['E3'])).params, { ref: 'e3' });
    await assert.rejects(async () => build('tap', ['button']), (e) => e.code === 'usage');
  });

  it('put takes text, empty text, or stdin', async () => {
    assert.equal((await build('put', ['e1', 'x'])).params.text, 'x');
    assert.equal((await build('put', ['e1', ''])).params.text, '');
    assert.equal((await build('put', ['e1'], { stdin: true })).params.text, 'from stdin');
    await assert.rejects(async () => build('put', ['e1']), (e) => e.code === 'usage');
    await assert.rejects(async () => build('put', ['e1', 'x'], { stdin: true }), (e) => e.code === 'usage');
  });

  it('scroll accepts directions and refs only', () => {
    assert.equal(COMMANDS.scroll.build(['DOWN'], {}).params.where, 'down');
    assert.equal(COMMANDS.scroll.build(['e9'], {}).params.where, 'e9');
    usage(() => COMMANDS.scroll.build(['sideways'], {}));
    usage(() => COMMANDS.scroll.build(['down'], { px: 'abc' }));
  });

  it('until validates its kinds', () => {
    assert.equal(COMMANDS.until.build(['text', 'Done'], {}).params.kind, 'text');
    assert.equal(COMMANDS.until.build(['idle'], {}).params.kind, 'idle');
    usage(() => COMMANDS.until.build(['text'], {}));
    usage(() => COMMANDS.until.build(['idle', 'x'], {}));
    usage(() => COMMANDS.until.build(['magic', 'x'], {}));
    usage(() => COMMANDS.until.build(['text', 'x'], { hidden: true }));
  });

  it('tabs maps its sub-commands', () => {
    assert.deepEqual(COMMANDS.tabs.build([], {}).params, { action: 'list' });
    assert.deepEqual(COMMANDS.tabs.build(['use', '2'], {}).params, { action: 'use', id: 2 });
    assert.deepEqual(COMMANDS.tabs.build(['close'], {}).params, { action: 'close' });
    usage(() => COMMANDS.tabs.build(['use'], {}));
    usage(() => COMMANDS.tabs.build(['use', 'x'], {}));
    usage(() => COMMANDS.tabs.build(['explode'], {}));
  });

  it('look bounds --limit', () => {
    assert.equal(COMMANDS.look.build([], { limit: '50' }).params.limit, 50);
    usage(() => COMMANDS.look.build([], { limit: '2' }));
    usage(() => COMMANDS.look.build([], { limit: '5001' }));
  });
});

describe('durations and paths', () => {
  it('parses durations', () => {
    assert.equal(parseDuration('5000'), 5000);
    assert.equal(parseDuration('800ms'), 800);
    assert.equal(parseDuration('5s'), 5000);
    assert.equal(parseDuration('1.5s'), 1500);
    assert.equal(parseDuration('2m'), 120000);
    usage(() => parseDuration('soon'));
    usage(() => parseDuration('50ms'));
    usage(() => parseDuration('11m'));
  });

  it('--timeout wins over BAC_TIMEOUT, which wins over the default', () => {
    assert.equal(parseTimeout('2s', { BAC_TIMEOUT: '9s' }), 2000);
    assert.equal(parseTimeout(undefined, { BAC_TIMEOUT: '9s' }), 9000);
    assert.equal(parseTimeout(undefined, {}), 10000);
  });

  it('validates session names', () => {
    assert.equal(validateSessionName('work-1'), 'work-1');
    usage(() => validateSessionName('../etc'));
    usage(() => validateSessionName('A'));
    usage(() => validateSessionName(''));
  });

  it('refuses socket paths that are too long', () => {
    assert.throws(() => sessionPaths(`/tmp/${'x'.repeat(120)}`, 'default'), (e) => e.code === 'daemon_unavailable');
  });
});

describe('screenshot paths', () => {
  const now = new Date(2026, 10, 12, 9, 8, 7, 6);

  it('defaults to a generated name inside the current directory', () => {
    const r = resolveShotPath(undefined, '/work/project', now);
    assert.equal(path.dirname(r.path), '/work/project');
    assert.equal(path.basename(r.path), 'bac-shot-20261112-090807-006.png');
    assert.equal(r.explicit, false);
    assert.equal(r.type, 'png');
  });

  it('uses an explicit path exactly, relative to the current directory', () => {
    assert.equal(resolveShotPath('out/page.png', '/work', now).path, '/work/out/page.png');
    assert.equal(resolveShotPath('../elsewhere/x.jpg', '/work/a', now).path, '/work/elsewhere/x.jpg');
    assert.equal(resolveShotPath('/tmp/abs.jpeg', '/work', now).type, 'jpeg');
    assert.equal(resolveShotPath('/tmp/abs.png', '/work', now).explicit, true);
  });

  it('requires an image extension', () => {
    usage(() => resolveShotPath('notes.txt', '/work', now));
    usage(() => resolveShotPath('noext', '/work', now));
  });
});

describe('main (no browser needed)', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { BAC_HOME: '/nonexistent/should-not-be-used' } } };
  };

  it('prints help and version', async () => {
    const c = capture();
    assert.equal(await main(['--help'], c.io), 0);
    assert.match(c.out.join('\n'), /usage: bac/);
    const v = capture();
    assert.equal(await main(['--version'], v.io), 0);
    assert.match(v.out[0], /^bac \d+\.\d+\.\d+$/);
    const h = capture();
    assert.equal(await main(['tap', '--help'], h.io), 0);
    assert.match(h.out.join('\n'), /usage: bac tap REF/);
  });

  it('refuses blocked URLs before starting any browser', async () => {
    const c = capture();
    assert.equal(await main(['go', 'file:///etc/passwd'], c.io), 6);
    assert.match(c.err[0], /^error\[blocked_url\]: .*file:/);
    const j = capture();
    assert.equal(await main(['--json', 'go', 'javascript:alert(1)'], j.io), 6);
    assert.equal(JSON.parse(j.out[0]).error.code, 'blocked_url');
  });

  it('refuses URLs outside --allow-domain before starting any browser', async () => {
    const c = capture();
    assert.equal(await main(['--allow-domain', 'example.com', 'go', 'https://evil.test/'], c.io), 6);
    assert.match(c.err[0], /not in the allowed domains/);
  });

  it('uses exit code 2 for usage errors', async () => {
    const c = capture();
    assert.equal(await main(['tap'], c.io), 2);
    assert.equal(await main([], capture().io), 2);
  });
});
