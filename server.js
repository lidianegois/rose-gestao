'use strict';
/*
 * Servidor da Rose Mercearia e Bazar.
 * - Entrega o site (pasta public/).
 * - Guarda os dados numa API simples de documentos: /api/col/<coleção>/<documento>.
 * - Usa PostgreSQL quando DATABASE_URL existe; sem ela, usa o arquivo data/<coleção>.json (só para testes locais).
 * - Senha opcional (APP_PASSWORD) protege o site e a API.
 * Sem frameworks: só o módulo http do Node e o driver "pg".
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 5 * 1024 * 1024; // 5 MB por documento
const APP_USER = process.env.APP_USER || 'rose';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SEG = /^[A-Za-z0-9_.~:@+-]{1,200}$/; // mesmo formato de nomes que o site já usa

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const store = createStore();

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(data);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type !== 'Basic' || !value) return false;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), APP_USER) && safeEqual(decoded.slice(i + 1), APP_PASSWORD);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Documento grande demais'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, parts) {
  // parts: ['api','col',<col>] ou ['api','col',<col>,'_version'] ou ['api','col',<col>,<id>]
  const col = parts[2];
  if (!col || !SEG.test(col)) return send(res, 400, { error: 'coleção inválida' });

  if (parts.length === 3 && req.method === 'GET') {
    const [docs, version] = await Promise.all([store.list(col), store.version()]);
    return send(res, 200, { version, docs });
  }
  if (parts.length === 4 && parts[3] === '_version' && req.method === 'GET') {
    return send(res, 200, { version: await store.version() });
  }
  if (parts.length === 4) {
    const id = parts[3];
    if (!SEG.test(id) || id === '.' || id === '..') return send(res, 400, { error: 'documento inválido' });
    if (req.method === 'PUT') {
      let data;
      try {
        data = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) throw e;
        return send(res, 400, { error: 'JSON inválido' });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'o corpo precisa ser um objeto JSON' });
      return send(res, 200, { version: await store.put(col, id, data) });
    }
    if (req.method === 'DELETE') {
      return send(res, 200, { version: await store.remove(col, id) });
    }
  }
  return send(res, 405, { error: 'método não permitido' });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Proibido');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Não encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (pathname === '/favicon.ico') return send(res, 204, '');
    if (!authorized(req)) {
      return send(res, 401, 'Acesso restrito', {
        'WWW-Authenticate': 'Basic realm="Rose Mercearia e Bazar", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      if (parts[1] !== 'col') return send(res, 404, { error: 'não encontrado' });
      return await handleApi(req, res, parts);
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'erro interno' });
  }
});

store
  .init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Rose Gestão rodando na porta ${PORT} · armazenamento: ${store.kind}${APP_PASSWORD ? ' · com senha' : ' · SEM senha'}`);
    });
  })
  .catch((e) => {
    console.error('Não foi possível iniciar o banco de dados:', e);
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
