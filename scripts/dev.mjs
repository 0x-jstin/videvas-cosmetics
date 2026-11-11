import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// Rollup watch avoids dependency-scanner access to folders outside the workspace.
// Changes trigger a complete build and refresh any connected preview tabs.
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 5173;
const root = resolve('dist');
const clients = new Set();
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  try {
    const file = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    let data = await readFile(file);
    const extension = extname(file);
    if (extension === '.html') data = data.toString().replace('</body>', '<script>new EventSource("/__reload").onmessage = () => location.reload();</script></body>');
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extension] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
const watcher = await build({ configFile: false, plugins: [react()], clearScreen: false, build: { watch: {} } });
let listening = false;
watcher.on('event', event => {
  if (event.code === 'ERROR') console.error(event.error);
  if (event.code === 'END') {
    if (!listening) { listening = true; server.listen(port, '127.0.0.1', () => console.log(`\nVidevas is ready at http://localhost:${port}/\n`)); }
    else clients.forEach(client => client.write('data: reload\n\n'));
  }
});
async function close() { clients.forEach(client => client.end()); server.closeAllConnections(); server.close(); await watcher.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
