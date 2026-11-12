// File-system locations: the private runtime directory that holds the daemon
// socket, and where screenshots go.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BacError, usageError } from './errors.js';

const SESSION_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// sun_path is 104 bytes on macOS and 108 on Linux; stay below both.
const MAX_SOCKET_PATH = 100;

export function validateSessionName(name) {
  if (!SESSION_RE.test(name)) {
    throw usageError(`invalid session name "${String(name).slice(0, 40)}". Use 1-32 characters from a-z, 0-9, _ and -`);
  }
  return name;
}

export function runtimeDirPath(env = process.env) {
  if (env.BAC_HOME) return path.resolve(env.BAC_HOME);
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'browser-agent-cli');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `browser-agent-cli-${uid}`);
}

// Create the runtime directory (mode 0700) or verify an existing one is safe:
// a real directory, owned by us, not readable by other users.
export function ensureRuntimeDir(env = process.env, { create = true } = {}) {
  const dir = runtimeDirPath(env);
  if (!create && !fs.existsSync(dir)) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new BacError('daemon_unavailable', `runtime path ${dir} is not a plain directory`);
  }
  if (typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) {
      throw new BacError('daemon_unavailable', `runtime directory ${dir} is owned by another user`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new BacError(
        'daemon_unavailable',
        `runtime directory ${dir} is accessible to other users. Run: chmod 700 ${dir}, or set BAC_HOME to a private directory`,
      );
    }
  }
  return dir;
}

export function sessionPaths(dir, session) {
  const socket = path.join(dir, `${session}.sock`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new BacError(
      'daemon_unavailable',
      `socket path is too long (${socket.length} chars). Set BAC_HOME to a shorter directory`,
    );
  }
  return {
    socket,
    pid: path.join(dir, `${session}.pid`),
    log: path.join(dir, `${session}.log`),
  };
}

function stamp(now) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
  );
}

const IMAGE_TYPES = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' };

// Decide where a screenshot goes.
//   * no argument: a generated name inside `cwd` (never anywhere else)
//   * explicit argument: exactly that path, relative to `cwd`
export function resolveShotPath(arg, cwd, now = new Date()) {
  if (arg === undefined || arg === null || arg === '') {
    return { path: path.join(cwd, `bac-shot-${stamp(now)}.png`), type: 'png', explicit: false };
  }
  if (String(arg).includes('\0')) throw usageError('screenshot path contains a null byte');
  const full = path.resolve(cwd, String(arg));
  const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
  if (!type) throw usageError('screenshot path must end in .png, .jpg or .jpeg');
  return { path: full, type, explicit: true };
}

// Write bytes without clobbering an existing file when the name was generated.
export function writeShot(target, bytes) {
  const flag = target.explicit ? 'w' : 'wx';
  try {
    fs.writeFileSync(target.path, bytes, { flag, mode: 0o644 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw usageError(`directory does not exist: ${path.dirname(target.path)}`);
    }
    if (err.code === 'EISDIR') throw usageError(`${target.path} is a directory`);
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw usageError(`cannot write ${target.path}: permission denied`);
    }
    throw err;
  }
  return target.path;
}

// "5000", "5000ms", "5s", "2m" -> milliseconds.
export function parseDuration(text, flag = '--timeout') {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(String(text).trim());
  if (!m) throw usageError(`${flag} must look like 5000, 800ms, 5s or 2m`);
  const unit = (m[2] || 'ms').toLowerCase();
  const ms = Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[unit]);
  if (ms < 100 || ms > 600000) throw usageError(`${flag} must be between 100ms and 10m`);
  return ms;
}
