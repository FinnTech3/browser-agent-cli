// The background process that owns the browser. It listens on a unix socket
// inside a private (0700) directory and answers one JSON request per
// connection. Requests run strictly one at a time.

import fs from 'node:fs';
import net from 'node:net';
import { BacError, toBacError } from './errors.js';
import { ensureRuntimeDir, sessionPaths, validateSessionName } from './paths.js';
import { parseAllowList, sameAllowList } from './policy.js';
import { pidAlive } from './proc.js';
import { Session } from './session.js';
import { PROTOCOL, VERSION } from './version.js';

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function log(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive ownership of a session name: whoever creates the pid file first
// wins. The file is written in full under a private name and then hard-linked
// into place, so another process can never see it empty or half written and
// mistake it for a stale file. A pid file whose process is gone is stale. Only
// the holder of a short-lived lock directory may remove it, so two daemons
// cannot both decide it is stale and delete each other's fresh claim.
export function acquirePidFile(file) {
  const temp = `${file}.${process.pid}.tmp`;
  const lock = `${file}.lock`;
  fs.writeFileSync(temp, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        fs.linkSync(temp, file);
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let pid = null;
      try {
        pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      } catch {
        continue; // removed meanwhile: try to claim it again
      }
      if (pid && pid !== process.pid && pidAlive(pid)) return false;
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock); // a crashed holder
        } catch {
          // the holder finished first
        }
        pause(10);
        continue;
      }
      try {
        const again = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
        if (again === pid) fs.unlinkSync(file); // still the same stale claim
      } catch {
        // already gone
      } finally {
        fs.rmdirSync(lock);
      }
    }
    return false;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function runDaemon(env = process.env) {
  const sessionName = validateSessionName(env.BAC_SESSION || 'default');
  const dir = ensureRuntimeDir(env);
  const paths = sessionPaths(dir, sessionName);
  const allow = parseAllowList(env.BAC_ALLOW ? JSON.parse(env.BAC_ALLOW) : null);
  const idleSeconds = Math.max(1, Number(env.BAC_IDLE_SECONDS) || 1800);
  const startedAt = Date.now();

  if (!acquirePidFile(paths.pid)) {
    log('another daemon already owns this session; exiting');
    return;
  }

  let session = null;
  let server = null;
  let stopping = false;
  let lastActivity = Date.now();
  let idleTimer = null;
  const sockets = new Set();

  const cleanupFiles = () => {
    for (const file of [paths.socket, paths.pid]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
    }
  };

  const shutdown = async (code = 0, why = 'shutdown requested') => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    clearInterval(idleTimer);
    if (server) server.close();
    for (const s of sockets) s.end();
    if (session) await session.close();
    cleanupFiles();
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGHUP', () => {});
  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err?.stack ?? err}`);
    shutdown(1, 'uncaught exception');
  });
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection: ${err?.stack ?? err}`);
  });
  process.on('exit', cleanupFiles);

  try {
    session = await Session.launch({
      allow,
      onDisconnect: () => {
        // Give an in-flight request a moment to report the failure first.
        setTimeout(() => shutdown(1, 'browser disconnected'), 300).unref?.();
      },
    });
  } catch (err) {
    log(`failed to start: ${err.message}`);
    cleanupFiles();
    process.exit(1);
  }

  try {
    fs.unlinkSync(paths.socket);
  } catch {
    // no stale socket
  }

  let queue = Promise.resolve();

  async function handle(request) {
    if (request.v !== PROTOCOL) {
      throw new BacError('daemon_unavailable', `daemon speaks protocol ${PROTOCOL}, client sent ${request.v}. Run: bac stop`);
    }
    if (request.allow !== undefined && request.allow !== null) {
      if (!sameAllowList(parseAllowList(request.allow), allow)) {
        const have = allow ? allow.join(', ') : 'no domain limit';
        throw new BacError(
          'policy_mismatch',
          `this session was started with ${have}. Run: bac stop, then start again with the domains you want`,
        );
      }
    }
    switch (request.cmd) {
      case 'status':
        return {
          running: true,
          pid: process.pid,
          version: VERSION,
          session: sessionName,
          uptimeMs: Date.now() - startedAt,
          idleSeconds,
          socket: paths.socket,
          ...session.info(),
        };
      case 'shutdown':
        setTimeout(() => shutdown(0, 'stop command'), 20);
        return { stopping: true };
      default: {
        const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 10000;
        const run = queue.then(() => session.exec(request.cmd, request.params ?? {}, timeoutMs));
        queue = run.catch(() => {});
        return run;
      }
    }
  }

  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: { code: 'usage', message: 'request too large' } })}\n`);
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      handled = true;
      lastActivity = Date.now();
      let reply;
      try {
        const request = JSON.parse(buffer.slice(0, end));
        reply = { ok: true, data: await handle(request) };
      } catch (err) {
        reply = { ok: false, error: toBacError(err).toJSON() };
        if (!(err instanceof BacError)) log(`internal error: ${err?.stack ?? err}`);
      }
      lastActivity = Date.now();
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(paths.socket, 0o600);

  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleSeconds * 1000) shutdown(0, `idle for ${idleSeconds}s`);
  }, Math.min(5000, Math.max(250, idleSeconds * 500)));

  log(`ready: pid ${process.pid}, session ${sessionName}, ${session.info().browser}`);
}
