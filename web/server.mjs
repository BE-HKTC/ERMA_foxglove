import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import handler from 'serve-handler';
import { WebSocketServer } from 'ws';
import wsProtocol from '@foxglove/ws-protocol';
const { FoxgloveServer, FoxgloveClient } = wsProtocol;
import { TargetRegistry } from './wsBridge.mjs';

const publicDir = path.join(process.cwd(), 'public');
const defaultLayoutsDir = '/foxglove/layouts';
const defaultDataDir = '/foxglove/data';
const layoutsDir = process.env.LAYOUTS_DIR || (await fs.access(defaultLayoutsDir).then(() => defaultLayoutsDir).catch(() => path.join(process.cwd(), 'layouts')));
const dataDir = process.env.DATA_DIR || (await fs.access(defaultDataDir).then(() => defaultDataDir).catch(() => path.join(process.cwd(), 'data')));
const indexPath = path.join(layoutsDir, 'index.json');

async function readIndex() {
  try {
    const text = await fs.readFile(indexPath, 'utf8');
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      if (typeof data[0] === 'string') {
        const now = new Date().toISOString();
        return data.map((name) => ({ name, createdAt: now, updatedAt: now }));
      }
      return data;
    }
    return [];
  } catch {
    return [];
  }
}

async function writeIndex(index) {
  await fs.writeFile(indexPath, JSON.stringify(index));
}

async function ensureLayoutIndex() {
  await fs.mkdir(layoutsDir, { recursive: true });
  try {
    await fs.access(indexPath);
  } catch {
    await writeIndex([]);
  }
}
await ensureLayoutIndex();

const registry = new TargetRegistry({ dataDir });

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    return handler(req, res, { public: publicDir });
  }

  if (req.url.startsWith('/api/layouts/') && req.method === 'POST') {
    // Toggle retention flag for a layout
    const name = req.url.slice('/api/layouts/'.length).replace(/\/$/, '').replace(/\/retention$/, '').split('/')[0];
    if (!req.url.endsWith('/retention')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const enabled = Boolean(payload.enabled);
        const index = await readIndex();
        const existing = index.find((i) => i.name === name);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Layout not found');
          return;
        }
        existing.retention = enabled;
        existing.updatedAt = new Date().toISOString();
        await writeIndex(index);
        await registry.syncFromIndex(index);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err));
      }
    });
    return;
  }

  if (req.url.startsWith('/layouts/')) {
    const relative = req.url.slice('/layouts/'.length);
    const target = path.join(layoutsDir, relative);

    if (req.method === 'GET') {
      try {
        const data = await fs.readFile(target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          await fs.writeFile(target, body);
          if (relative !== 'index.json') {
            const name = path.basename(relative, '.json');
            const now = new Date().toISOString();
            const index = await readIndex();
            const existing = index.find((item) => item.name === name);
            const targetHeader = req.headers['x-layout-target'];
            const hasTargetHeader = typeof targetHeader === 'string';
            const targetRaw = hasTargetHeader ? targetHeader.trim() : undefined;
            const targetName = targetRaw && targetRaw.length > 0 ? targetRaw : undefined;
            const retentionHeader = req.headers['x-layout-retention'];
            const topicsHeader = req.headers['x-layout-topics'];
            const topicsList =
              typeof topicsHeader === 'string'
                ? topicsHeader
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                : undefined;
            if (existing) {
              existing.updatedAt = now;
              if (hasTargetHeader) {
                existing.target = targetName;
              }
              if (typeof retentionHeader === 'string') {
                existing.retention = retentionHeader === 'true';
              }
              if (topicsList != undefined) {
                existing.topics = topicsList.length > 0 ? topicsList : undefined;
              }
            } else {
              index.push({
                name,
                target: hasTargetHeader ? targetName : undefined,
                retention: typeof retentionHeader === 'string' ? retentionHeader === 'true' : undefined,
                topics: topicsList && topicsList.length > 0 ? topicsList : undefined,
                createdAt: now,
                updatedAt: now,
              });
            }
            await writeIndex(index);
            // Update registry after any layout change
            await registry.syncFromIndex(index);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(String(err));
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      try {
        await fs.unlink(target);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const name = path.basename(relative, '.json');
      const index = (await readIndex()).filter((item) => item.name !== name);
      await writeIndex(index);
      await registry.syncFromIndex(index);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  return handler(req, res, { public: publicDir });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`server listening on ${port}`);
});

// WebSocket bridge for history + live
const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    const slug = url.pathname.replace('/ws/', '').trim();
    if (!slug) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      // Create a per-connection FoxgloveServer instance
      const fgServer = new FoxgloveServer({ name: `ERMA Bridge ${slug}`, capabilities: [] });
      // Wire ws-protocol server onto this raw ws connection
      const protocols = req.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()) || [];
      const chosen = fgServer.handleProtocols(protocols);
      if (chosen === false) {
        ws.close(1002, 'Unsupported protocol');
        return;
      }
      // Echo the chosen subprotocol if requested (ws library doesn’t set it automatically here)
      try { ws.protocol = chosen; } catch {}
      fgServer.handleConnection(ws, `client@${slug}`);

      const lookbackParam = (new URLSearchParams(url.search)).get('lookback') || '';
      const manager = await registry.getOrCreate(slug);
      await manager.attachClientServer(fgServer, { lookback: lookbackParam });
    });
  } catch {
    socket.destroy();
  }
});

// Initialize registry from layouts index
readIndex().then((index) => registry.syncFromIndex(index)).catch(() => {});
