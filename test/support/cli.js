// Helpers for end-to-end tests: run the real bin/bac.js against a private
// runtime directory and session so tests never touch a user's daemon.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'bac.js');

export function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bac-'));
}

export class Bac {
  constructor({ home, session = 'test', env = {}, cwd } = {}) {
    this.ownsHome = !home;
    home ??= makeHome();
    cwd ??= home;
    this.home = home;
    this.session = session;
    this.cwd = cwd;
    this.env = {
      ...process.env,
      BAC_HOME: home,
      BAC_SESSION: session,
      BAC_IDLE_SECONDS: '120',
      BAC_ALLOW_DOMAINS: '',
      ...env,
    };
  }

  // Run `bac ...args`; resolves to { code, stdout, stderr, json? }.
  run(args, { env = {}, cwd = this.cwd, input } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        env: { ...this.env, ...env },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        let json;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
        resolve({ code, stdout, stderr, json });
      });
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  }

  async ok(args, opts) {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new Error(`bac ${args.join(' ')} exited ${r.code}: ${r.stderr || r.stdout}`);
    return r;
  }

  // Find the ref of the first node line matching role and name in a plain look.
  static refFor(output, role, name) {
    const re = new RegExp(`\\b(e\\d+) ${role}${name === undefined ? '' : ` "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`}`);
    const m = re.exec(output);
    if (!m) throw new Error(`no ${role} ${name ?? ''} in:\n${output}`);
    return m[1];
  }

  pid() {
    try {
      return Number.parseInt(fs.readFileSync(path.join(this.home, `${this.session}.pid`), 'utf8'), 10);
    } catch {
      return null;
    }
  }

  async cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.run(['stop'], { cwd: os.tmpdir() }).catch(() => {});
    if (this.ownsHome) fs.rmSync(this.home, { recursive: true, force: true });
  }
}

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) [ZX]/.test(stat);
  } catch {
    return true;
  }
}

export function childPids(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map(Number);
}
