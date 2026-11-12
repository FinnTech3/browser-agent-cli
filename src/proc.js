// Process liveness helpers shared by the client and the daemon.

import fs from 'node:fs';

// True when the process exists and is not a zombie.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return true; // no /proc (macOS): trust kill(pid, 0)
  }
}

// Guard against pid reuse: where /proc exists, the process must be our daemon.
export function isOurDaemon(pid) {
  if (!pidAlive(pid)) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('daemon-main.js');
  } catch {
    return true;
  }
}
