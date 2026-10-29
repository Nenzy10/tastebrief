// Zero-dependency local dev server: serves public/ and routes /api/brief
// to the same Netlify Function used in production.
// Usage:  QLOO_API_KEY=... node scripts/dev.mjs   (port 8899 by default)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from '../netlify/functions/brief.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = process.env.PORT || 8899;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/brief') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const event = {
        httpMethod: req.method,
        body: body || null,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: req.headers,
      };
      const out = await handler(event);
      res.writeHead(out.statusCode, out.headers || { 'Content-Type': 'application/json' });
      res.end(out.body);
    });
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, () => console.log(`TasteBrief dev server on http://localhost:${PORT}`));
