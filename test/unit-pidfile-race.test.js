import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('../src/daemon.js', import.meta.url));

// Each child waits for the same start time, then tries to claim the pid file and holds on for a moment.
const CHILD = `
const { acquirePidFile } = await import(${JSON.stringify(`file://${DAEMON}`)});
const [file, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) { /* spin until the shared start time */ }
const won = acquirePidFile(file);
process.stdout.write(won ? 'won' : 'lost');
if (won) await new Promise((resolve) => setTimeout(resolve, 600));
`;

function race(file, count) {
  const startAt = Date.now() + 700;
  return Promise.all(
    Array.from({ length: count }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, file, String(startAt)]);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    })),
  );
}

describe('claiming a session pid file', () => {
  it('has exactly one winner when many daemons start at the same moment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-pid-'));
    for (let round = 0; round < 3; round += 1) {
      const file = path.join(dir, `session-${round}.pid`);
      const results = await race(file, 12);
      assert.equal(results.filter((r) => r === 'won').length, 1, `round ${round}: ${results.join(',')}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has exactly one winner when many daemons find the same stale pid file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-pid-'));
    for (let round = 0; round < 3; round += 1) {
      const file = path.join(dir, `stale-${round}.pid`);
      fs.writeFileSync(file, '2147483646\n'); // a pid that cannot be running
      const results = await race(file, 12);
      assert.equal(results.filter((r) => r === 'won').length, 1, `round ${round}: ${results.join(',')}`);
      assert.deepEqual(fs.readdirSync(dir).filter((n) => /\.(lock|tmp)$/.test(n)), [], 'no lock or temporary file is left');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never exposes a half-written pid file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-pid-'));
    const file = path.join(dir, 'session.pid');
    const { acquirePidFile } = await import(DAEMON);
    assert.equal(acquirePidFile(file), true);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
    assert.deepEqual(fs.readdirSync(dir), ['session.pid'], 'no temporary file is left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
