import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import handler from 'serve-handler';

const publicDir = path.join(process.cwd(), 'public');
const layoutsDir = path.join(publicDir, 'layouts');
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

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    return handler(req, res, { public: publicDir });
  }

  if (req.method === 'PUT' && req.url.startsWith('/layouts/')) {
    const relative = req.url.slice('/layouts/'.length);
    const target = path.join(layoutsDir, relative);
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
          if (existing) {
            existing.updatedAt = now;
          } else {
            index.push({ name, createdAt: now, updatedAt: now });
          }
          await writeIndex(index);
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

  if (req.method === 'DELETE' && req.url.startsWith('/layouts/')) {
    const relative = req.url.slice('/layouts/'.length);
    const target = path.join(layoutsDir, relative);
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  return handler(req, res, { public: publicDir });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`server listening on ${port}`);
});
