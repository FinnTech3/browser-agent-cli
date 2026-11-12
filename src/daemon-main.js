// Entry point for the background process. Started by the client, not by hand.
import { runDaemon } from './daemon.js';

runDaemon().catch((err) => {
  process.stderr.write(`daemon failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
