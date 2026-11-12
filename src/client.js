// Talks to the daemon over its unix socket and starts it when needed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacError } from './errors.js';
import { ensureRuntimeDir, sessionPaths } from './paths.js';
import { isOurDaemon, pidAlive } from './proc.js';
import { PROTOCOL } from './version.js';

const DAEMON_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-main.js');
const START_TIMEOUT_MS = 25000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removeStale(paths) {
  for (const file of [paths.socket, paths.pid]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // not there
    }
  }
}

// Last lines the daemon wrote after byte offset `from`, so an earlier failed
// start is not repeated in this one's message.
function logTail(file, from = 0) {
  try {
    const lines = fs.readFileSync(file, 'utf8').slice(from).trim().split('\n');
    return [...new Set(lines.slice(-3).map((l) => l.replace(/^\S+\s/, '')))].join(' | ');
  } catch {
    return '';
  }
}

function spawnDaemon(env, dir, session, allow, paths) {
  try {
    if (fs.statSync(paths.log).size > 200_000) fs.truncateSync(paths.log, 0);
  } catch {
    // no log yet
  }
  const logFd = fs.openSync(paths.log, 'a', 0o600);
  const logStart = fs.fstatSync(logFd).size;
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...env,
      BAC_HOME: dir,
      BAC_SESSION: session,
      BAC_ALLOW: allow ? JSON.stringify(allow) : '',
    },
  });
  fs.closeSync(logFd);
  child.unref();
  child.logStart = logStart;
  return child;
}

// Wait until the daemon accepts connections. `child` is the process we just
// spawned, or null when we are waiting for a daemon someone else started.
async function waitForSocket(paths, child) {
  let own = child;
  let exited = null;
  const onExit = (code) => {
    exited = code ?? 1;
  };
  own?.once('exit', onExit);
  const deadline = Date.now() + START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        return await connect(paths.socket);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') throw err;
      }
      const pid = readPid(paths.pid);
      const ownerAlive = !!pid && isOurDaemon(pid);
      if (exited !== null && own) {
        // Our daemon quit. If it lost the race to another daemon, wait for that one.
        if (!ownerAlive) {
          const why = logTail(paths.log, own.logStart ?? 0);
          throw new BacError('daemon_unavailable', `browser daemon exited during start${why ? `: ${why}` : ''}`);
        }
        own.off('exit', onExit);
        own = null;
      }
      if (!own && !ownerAlive) return null;
      await sleep(40);
    }
  } finally {
    own?.off('exit', onExit);
  }
  throw new BacError('daemon_unavailable', 'the browser daemon did not become ready in time. Run: bac stop, then retry');
}

// Returns a connected socket, starting the daemon if it is not running.
async function connectOrStart({ env, session, allow }) {
  const dir = ensureRuntimeDir(env);
  const paths = sessionPaths(dir, session);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await connect(paths.socket);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') {
        throw new BacError('daemon_unavailable', `cannot reach the daemon socket: ${err.code ?? err.message}`);
      }
    }
    const pid = readPid(paths.pid);
    if (pid && isOurDaemon(pid)) {
      // Starting up, or busy. Wait for it instead of starting a second one.
      const socket = await waitForSocket(paths, null);
      if (socket) return socket;
      continue;
    }
    removeStale(paths);
    const child = spawnDaemon(env, dir, session, allow, paths);
    return waitForSocket(paths, child);
  }
  throw new BacError('daemon_unavailable', 'could not start the browser daemon. Run: bac stop, then retry');
}

function exchange(socket, payload, waitMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new BacError('daemon_unavailable', 'the daemon did not answer in time. Run: bac stop, then retry')),
      waitMs,
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        finish(resolve, JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(reject, new BacError('daemon_unavailable', 'the daemon sent an unreadable reply. Run: bac stop, then retry'));
      }
    });
    socket.on('close', () =>
      finish(
        reject,
        new BacError(
          'browser_lost',
          'the browser session ended during the command (crash or stop). Run the command again to start a fresh session',
        ),
      ),
    );
    socket.on('error', (err) =>
      finish(reject, new BacError('daemon_unavailable', `daemon connection failed: ${err.code ?? err.message}`)),
    );
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

// Send a command. Starts the daemon unless `start` is false.
// Returns the data object, or throws BacError.
export async function send({ env, session, allow = null, cmd, params = {}, timeoutMs = 10000, start = true }) {
  let socket;
  if (start) {
    socket = await connectOrStart({ env, session, allow });
  } else {
    const dir = ensureRuntimeDir(env, { create: false });
    if (!dir) return null;
    const paths = sessionPaths(dir, session);
    try {
      socket = await connect(paths.socket);
    } catch {
      return null;
    }
  }
  const reply = await exchange(
    socket,
    { v: PROTOCOL, cmd, params, timeoutMs, allow },
    timeoutMs + 20000,
  );
  if (!reply.ok) throw new BacError(reply.error.code, reply.error.message);
  return reply.data;
}

// Ask the daemon to quit; fall back to signals if it does not answer.
export async function stopSession({ env, session }) {
  const grace = Math.max(200, Number(env.BAC_STOP_GRACE_MS) || 8000);
  const dir = ensureRuntimeDir(env, { create: false });
  if (!dir) return { wasRunning: false, forced: false };
  const paths = sessionPaths(dir, session);
  const pid = readPid(paths.pid);
  let asked = false;
  try {
    const socket = await connect(paths.socket);
    asked = true;
    await exchange(socket, { v: PROTOCOL, cmd: 'shutdown' }, grace).catch(() => {});
  } catch {
    // not reachable
  }
  if (!asked && !(pid && isOurDaemon(pid))) {
    removeStale(paths);
    return { wasRunning: false, forced: false };
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && pid && pidAlive(pid)) await sleep(50);
  let forced = false;
  if (pid && isOurDaemon(pid)) {
    forced = true;
    process.kill(pid, 'SIGTERM');
    const end = Date.now() + Math.min(grace, 2500);
    while (Date.now() < end && pidAlive(pid)) await sleep(50);
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    // SIGKILL is asynchronous: wait until the process is really gone before reporting success.
    const gone = Date.now() + 2000;
    while (Date.now() < gone && pidAlive(pid)) await sleep(20);
  }
  removeStale(paths);
  return { wasRunning: true, forced };
}
