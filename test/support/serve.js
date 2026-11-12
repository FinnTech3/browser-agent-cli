// Serve the fixture pages so you can try the CLI by hand:
//   node test/support/serve.js 8765
import { startFixtureServer } from './server.js';

const port = Number(process.argv[2] ?? 8765);
const { origin } = await startFixtureServer({ port });
process.stdout.write(`serving fixtures at ${origin}/  (Ctrl+C to stop)\n`);
