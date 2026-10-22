// A tiny static file server for the webview test harness. Serves the repo root on 127.0.0.1.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 4173);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
};

createServer((req, res) => {
  // Only answer requests addressed to this server, so a web page can't reach it by DNS rebinding.
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return void res.writeHead(421).end();
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  const file = join(root, path);
  if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    return void res.writeHead(404).end();
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
