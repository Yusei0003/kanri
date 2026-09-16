'use strict';
// kanri - Claude Code で作ったアプリを管理するローカルダッシュボード
// 依存パッケージなし。127.0.0.1 のみで待ち受ける。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const store = require('./lib/store');
const runner = require('./lib/runner');
const git = require('./lib/git');
const { scan } = require('./lib/scan');

const PORT = Number(process.env.PORT) || 7788;
const HOST = '127.0.0.1'; // 外部からは接続できない
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON を解釈できません')); }
    });
    req.on('error', reject);
  });
}

function openExternally(target) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

const appUrl = (app) => app.url || (app.port ? `http://localhost:${app.port}` : '');

async function decorate(app) {
  return { ...app, runtime: runner.state(app.id), git: await git.info(app.repoPath), effectiveUrl: appUrl(app) };
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // public/ の外は絶対に返さない
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'apps', id?, action?]
  const [, resource, id, action] = segments;
  const method = req.method;

  if (resource === 'apps' && !id) {
    if (method === 'GET') {
      return json(res, 200, { apps: await Promise.all(store.listApps().map(decorate)) });
    }
    if (method === 'POST') {
      return json(res, 201, { app: await decorate(store.addApp(await readBody(req))) });
    }
  }

  if (resource === 'apps' && id && !action) {
    const app = store.getApp(id);
    if (!app) return json(res, 404, { error: 'アプリが見つかりません' });
    if (method === 'GET') return json(res, 200, { app: await decorate(app) });
    if (method === 'PATCH' || method === 'PUT') {
      const updated = store.updateApp(id, await readBody(req));
      git.invalidate(updated.repoPath);
      return json(res, 200, { app: await decorate(updated) });
    }
    if (method === 'DELETE') {
      if (runner.isRunning(id)) runner.stop(id);
      store.removeApp(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'apps' && id && action) {
    const app = store.getApp(id);
    if (!app) return json(res, 404, { error: 'アプリが見つかりません' });

    if (action === 'start' && method === 'POST') {
      const result = runner.start(app);
      if (!result.ok) return json(res, 400, { error: result.error });
      store.updateApp(id, { lastStartedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, runtime: runner.state(id) });
    }
    if (action === 'stop' && method === 'POST') {
      const result = runner.stop(id);
      if (!result.ok) return json(res, 400, { error: result.error });
      return json(res, 200, { ok: true });
    }
    if (action === 'logs' && method === 'GET') {
      return json(res, 200, { logs: runner.logs(id), runtime: runner.state(id) });
    }
    if (action === 'open' && method === 'POST') {
      const target = appUrl(app);
      if (!target) return json(res, 400, { error: 'URL もポートも未設定です' });
      return json(res, 200, { ok: openExternally(target), url: target });
    }
    if (action === 'reveal' && method === 'POST') {
      if (!app.repoPath || !fs.existsSync(app.repoPath)) return json(res, 400, { error: 'フォルダが見つかりません' });
      return json(res, 200, { ok: openExternally(app.repoPath) });
    }
    if (action === 'refresh' && method === 'POST') {
      git.invalidate(app.repoPath);
      return json(res, 200, { app: await decorate(app) });
    }
  }

  if (resource === 'scan' && method === 'POST') {
    const { root } = await readBody(req);
    if (!root) return json(res, 400, { error: 'フォルダを指定してください' });
    if (!fs.existsSync(root)) return json(res, 400, { error: `フォルダが見つかりません: ${root}` });
    const known = new Set(store.listApps().map((a) => path.resolve(a.repoPath)));
    const found = scan(root).map((f) => ({ ...f, registered: known.has(path.resolve(f.repoPath)) }));
    return json(res, 200, { found });
  }

  if (resource === 'import' && method === 'POST') {
    const { items } = await readBody(req);
    const known = new Set(store.listApps().map((a) => path.resolve(a.repoPath)));
    const added = [];
    for (const item of items || []) {
      if (!item?.repoPath || known.has(path.resolve(item.repoPath))) continue;
      const info = await git.info(item.repoPath, { force: true });
      added.push(store.addApp({ ...item, github: info.githubUrl || '', status: 'developing' }));
      known.add(path.resolve(item.repoPath));
    }
    return json(res, 200, { added: await Promise.all(added.map(decorate)) });
  }

  if (resource === 'settings') {
    if (method === 'GET') return json(res, 200, { settings: store.getSettings() });
    if (method === 'PUT' || method === 'PATCH') {
      return json(res, 200, { settings: store.updateSettings(await readBody(req)) });
    }
  }

  return json(res, 404, { error: `未対応のエンドポイントです: ${method} ${url.pathname}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`kanri を起動しました → ${address}`);
  if (process.env.KANRI_NO_OPEN !== '1') openExternally(address);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[kanri] 起動中のアプリを停止して終了します');
    runner.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
