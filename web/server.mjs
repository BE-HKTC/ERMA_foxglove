import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import handler from 'serve-handler';

const publicDir = path.join(process.cwd(), 'public');
const layoutsDir = path.join(publicDir, 'layouts');
const indexPath = path.join(layoutsDir, 'index.json');

async function ensureLayoutIndex() {
  await fs.mkdir(layoutsDir, { recursive: true });
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, '[]');
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
          let names = [];
          try {
            names = JSON.parse(await fs.readFile(indexPath, 'utf8'));
          } catch {
            names = [];
          }
          const name = path.basename(relative, '.json');
          if (!names.includes(name)) {
            names.push(name);
            await fs.writeFile(indexPath, JSON.stringify(names));
          }
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

  return handler(req, res, { public: publicDir });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`server listening on ${port}`);
});
