// Serve docs/media-src/site on http://127.0.0.1:PORT (default 8765). The pages are fictional demo pages, made for
// the README media. The footer of signup.html carries a planted instruction aimed at agents, on purpose.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const port = Number(process.argv[2] ?? 8765);
http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname) || 'signup.html';
  const file = path.join(root, name);
  if (!file.endsWith('.html') || !fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
}).listen(port, '127.0.0.1', () => process.stdout.write(`serving demo pages at http://127.0.0.1:${port}/\n`));
