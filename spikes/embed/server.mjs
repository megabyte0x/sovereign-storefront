#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let path = url.pathname;
  if (path === '/') path = '/index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  readFile(file)
    .then((body) => {
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    })
    .catch(() => {
      res.writeHead(404);
      res.end('not found');
    });
}

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const hosts = ['127.0.0.1', '::1'];
const ports = [5001, 5002];
const servers = [];
for (const port of ports) {
  for (const host of hosts) {
    servers.push(await listen(port, host));
  }
}

console.log('embedder http://a.localhost:5001/');
console.log('storefront http://s.localhost:5002/');

function shutdown() {
  for (const s of servers) s.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
