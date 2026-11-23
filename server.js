'use strict';
/*
 * Servidor da Rose Mercearia e Bazar.
 * - Entrega o site (pasta public/) só para quem entrou com usuário e senha.
 * - Página de entrada em /login; contas de usuário com papel "admin" ou "operador".
 * - Guarda os dados numa API simples de documentos: /api/col/<coleção>/<documento>.
 * - Usa PostgreSQL quando DATABASE_URL existe; sem ela, usa o arquivo data/banco-local.json (só para testes locais).
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
const SEG = /^[A-Za-z0-9_.~:@+-]{1,200}$/; // mesmo formato de nomes que o site já usa
const COOKIE = 'rose_sessao';
const SESSION_DAYS = 30;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('Aviso: SESSION_SECRET não definido; as sessões terminam quando o servidor reinicia.');

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

/* ---------- respostas ---------- */
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(data);
}
function redirect(res, to, headers = {}) {
  res.writeHead(303, { ...BASE_HEADERS, Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Conteúdo grande demais'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, max) {
  const raw = await readBody(req, max);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

/* ---------- senhas: guardadas só como hash scrypt ---------- */
function hashPassword(pass) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pass, salt, 64, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`)));
  });
}
function checkPassword(pass, stored) {
  return new Promise((resolve) => {
    const [kind, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return resolve(false);
    const expected = Buffer.from(hash, 'base64');
    crypto.scrypt(pass, Buffer.from(salt, 'base64'), expected.length, (err, key) => resolve(!err && crypto.timingSafeEqual(key, expected)));
  });
}
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/* ---------- usuários (cópia em memória, renovada a cada mudança e a cada 30 s) ---------- */
let usersCache = null;
let usersAt = 0;
async function users(force) {
  if (force || !usersCache || Date.now() - usersAt > 30000) {
    usersCache = await store.users();
    usersAt = Date.now();
  }
  return usersCache;
}
/* ---------- perfis (RBAC) ----------
 * admin   (Administradora): tudo, inclusive usuários, backup e apagar dados.
 * gerente (Gerente):        todas as telas da loja, sem usuários nem apagar dados.
 * caixa   (Caixa):          Caixa, Vendas e Clientes e fiado; só grava vendas, caixas, fiado e cadastros de clientes.
 */
const ALL_TABS = ['painel', 'caixa', 'vendas', 'clientes', 'produtos', 'movimentacoes', 'notas', 'compras', 'fornecedores', 'financeiro', 'analise'];
const ROLES = {
  admin: { label: 'Administradora', tabs: ALL_TABS, write: /./, del: true, users: true, data: true },
  gerente: { label: 'Gerente', tabs: ALL_TABS, write: /./, del: true, users: false, data: false },
  caixa: { label: 'Caixa', tabs: ['caixa', 'vendas', 'clientes'], write: /^(cadastros|caixas|lancamentos|vendas-\d{4}-\d{2})$/, del: false, users: false, data: false },
};
const roleOf = (u) => (ROLES[u.role] ? u.role : u.role === 'operador' ? 'gerente' : 'caixa');
const perms = (u) => { const r = ROLES[roleOf(u)]; return { role: roleOf(u), label: r.label, tabs: r.tabs, users: r.users, data: r.data }; };
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: roleOf(u), active: u.active, created_at: u.created_at, last_login: u.last_login });
const USERNAME = /^[a-z0-9._-]{3,30}$/;

/* ---------- sessão: cookie assinado com o id do usuário, a validade e a versão da senha ---------- */
const sign = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeCookie(u, req) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = Buffer.from(JSON.stringify({ id: u.id, v: u.pwv, e: exp })).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
async function currentUser(req) {
  const raw = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!data || !(data.e > Date.now())) return null;
  const u = (await users()).find((x) => x.id === data.id);
  if (!u || !u.active || u.pwv !== data.v) return null;
  return u;
}

/* ---------- limite de tentativas: 10 erros em 15 minutos por endereço ---------- */
const attempts = new Map();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function tooMany(ip) {
  const a = attempts.get(ip);
  return !!a && a.n >= 10 && Date.now() - a.t < 15 * 60000;
}
function failed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.t > 15 * 60000) attempts.set(ip, { n: 1, t: Date.now() });
  else a.n++;
}

/* ---------- conta ---------- */
async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) return send(res, 429, { error: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
  const body = await readJson(req, 10000);
  const username = String(body.usuario || '').trim().toLowerCase();
  const pass = String(body.senha || '');
  const u = (await users(true)).find((x) => x.username === username);
  const ok = await checkPassword(pass, u ? u.pass : DUMMY_HASH);
  if (!u || !ok) {
    failed(ip);
    return send(res, 401, { error: 'Usuário ou senha incorretos.' });
  }
  if (!u.active) return send(res, 403, { error: 'Este usuário está desativado. Fale com a administradora.' });
  attempts.delete(ip);
  store.updateUser(u.id, { last_login: new Date().toISOString() }).catch(() => {});
  return send(res, 200, { ok: true, user: publicUser(u) }, { 'Set-Cookie': makeCookie(u, req) });
}

async function handleOwnPassword(req, res, me) {
  const b = await readJson(req, 10000);
  if (!(await checkPassword(String(b.atual || ''), me.pass))) return send(res, 400, { error: 'A senha atual não confere.' });
  const pass = String(b.nova || '');
  if (pass.length < 8) return send(res, 400, { error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  await store.updateUser(me.id, { pass: await hashPassword(pass), pwv: me.pwv + 1 });
  const fresh = (await users(true)).find((x) => x.id === me.id);
  return send(res, 200, { ok: true }, { 'Set-Cookie': makeCookie(fresh, req) });
}

// /api/usuarios (GET lista, POST cria) e /api/usuarios/<id> (PATCH altera). Só administradoras.
async function handleUsers(req, res, me, id) {
  if (!ROLES[roleOf(me)].users) return send(res, 403, { error: 'Só a administradora pode gerenciar usuários.' });
  const all = await users(true);
  if (!id && req.method === 'GET') return send(res, 200, { users: all.map(publicUser) });
  if (!id && req.method === 'POST') {
    const b = await readJson(req, 10000);
    const username = String(b.usuario || '').trim().toLowerCase();
    const name = String(b.nome || '').trim().slice(0, 60);
    const pass = String(b.senha || '');
    const role = ROLES[b.papel] ? b.papel : 'caixa';
    if (!USERNAME.test(username)) return send(res, 400, { error: 'O usuário precisa ter de 3 a 30 caracteres: letras minúsculas, números, ponto, traço ou sublinhado, sem espaços.' });
    if (!name) return send(res, 400, { error: 'Informe o nome.' });
    if (pass.length < 8) return send(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (all.some((x) => x.username === username)) return send(res, 409, { error: 'Já existe um usuário com esse nome de acesso.' });
    const u = { id: 'u' + crypto.randomBytes(6).toString('hex'), username, name, pass: await hashPassword(pass), role, active: true, pwv: 1 };
    await store.createUser(u);
    await users(true);
    return send(res, 201, { user: publicUser(u) });
  }
  if (id && req.method === 'PATCH') {
    const u = all.find((x) => x.id === id);
    if (!u) return send(res, 404, { error: 'Usuário não encontrado.' });
    const b = await readJson(req, 10000);
    const f = {};
    const isLastAdmin = roleOf(u) === 'admin' && u.active && all.filter((x) => roleOf(x) === 'admin' && x.active).length === 1;
    if (b.nome !== undefined) {
      const name = String(b.nome).trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'Informe o nome.' });
      f.name = name;
    }
    if (b.papel !== undefined) {
      if (!ROLES[b.papel]) return send(res, 400, { error: 'Perfil inválido.' });
      const role = b.papel;
      if (role !== 'admin' && isLastAdmin) return send(res, 400, { error: 'É preciso ter pelo menos uma administradora ativa.' });
      f.role = role;
    }
    if (b.ativo !== undefined) {
      const active = !!b.ativo;
      if (!active && u.id === me.id) return send(res, 400, { error: 'Você não pode desativar a sua própria conta.' });
      if (!active && isLastAdmin) return send(res, 400, { error: 'É preciso ter pelo menos uma administradora ativa.' });
      f.active = active;
      if (!active) f.pwv = u.pwv + 1; // derruba as sessões abertas
    }
    if (b.senha !== undefined) {
      const pass = String(b.senha);
      if (pass.length < 8) return send(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
      f.pass = await hashPassword(pass);
      f.pwv = u.pwv + 1;
    }
    await store.updateUser(u.id, f);
    const fresh = (await users(true)).find((x) => x.id === u.id);
    const headers = fresh.id === me.id && f.pwv ? { 'Set-Cookie': makeCookie(fresh, req) } : {};
    return send(res, 200, { user: publicUser(fresh) }, headers);
  }
  return send(res, 405, { error: 'método não permitido' });
}

/* ---------- dados ---------- */
async function handleData(req, res, parts, me) {
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
    const r = ROLES[roleOf(me)];
    if ((req.method === 'PUT' && !r.write.test(id)) || (req.method === 'DELETE' && !r.del)) {
      return send(res, 403, { error: `O perfil ${r.label} não pode alterar esta parte do sistema.` });
    }
    if (req.method === 'PUT') {
      const data = await readJson(req);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'o corpo precisa ser um objeto JSON' });
      return send(res, 200, { version: await store.put(col, id, data) });
    }
    if (req.method === 'DELETE') return send(res, 200, { version: await store.remove(col, id) });
  }
  return send(res, 405, { error: 'método não permitido' });
}

/* ---------- arquivos ---------- */
function serveFile(req, res, rel) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Proibido');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Não encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- rotas ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(pathname);

    // abertas a todos
    if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (p === '/favicon.ico') return send(res, 204, '');
    if (p === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (p === '/sair') return redirect(res, '/login', { 'Set-Cookie': CLEAR_COOKIE });
    const me = await currentUser(req);
    if (p === '/login') return me ? redirect(res, '/') : serveFile(req, res, '/login.html');

    // daqui para baixo, só com sessão
    const parts = p.split('/').filter(Boolean);
    if (!me) return parts[0] === 'api' ? send(res, 401, { error: 'Entre com seu usuário e senha.' }) : redirect(res, '/login');
    if (parts[0] === 'api') {
      if (parts[1] === 'me' && parts.length === 2 && req.method === 'GET') return send(res, 200, { user: { ...publicUser(me), ...perms(me) } });
      if (parts[1] === 'senha' && parts.length === 2 && req.method === 'POST') return await handleOwnPassword(req, res, me);
      if (parts[1] === 'perfis' && parts.length === 2 && req.method === 'GET') return send(res, 200, { perfis: Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label, tabs: r.tabs, users: r.users, data: r.data })) });
      if (parts[1] === 'usuarios' && parts.length <= 3) return await handleUsers(req, res, me, parts[2]);
      if (parts[1] === 'col') return await handleData(req, res, parts, me);
      return send(res, 404, { error: 'não encontrado' });
    }
    if (p === '/' || p === '/index.html') return serveFile(req, res, '/index.html');
    if (p === '/usuarios') return ROLES[roleOf(me)].users ? serveFile(req, res, '/usuarios.html') : redirect(res, '/');
    if (p === '/login.html' || p === '/usuarios.html') return redirect(res, '/');
    return serveFile(req, res, p);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'erro interno' });
  }
});

/* ---------- início: cria a primeira administradora se ainda não houver usuários ---------- */
async function bootstrapAdmin() {
  if ((await users(true)).length) return;
  const username = String(process.env.APP_USER || 'rose').trim().toLowerCase();
  const pass = process.env.APP_PASSWORD;
  if (!pass) {
    console.warn('Nenhum usuário cadastrado e APP_PASSWORD não definido: defina APP_USER e APP_PASSWORD para criar a primeira administradora.');
    return;
  }
  await store.createUser({ id: 'u' + crypto.randomBytes(6).toString('hex'), username, name: process.env.APP_NAME || 'Rose', pass: await hashPassword(pass), role: 'admin', active: true, pwv: 1 });
  await users(true);
  console.log(`Primeira administradora criada: ${username}`);
}

store
  .init()
  .then(bootstrapAdmin)
  .then(() => {
    server.listen(PORT, () => console.log(`Rose Gestão rodando na porta ${PORT} · armazenamento: ${store.kind} · login por usuário`));
  })
  .catch((e) => {
    console.error('Não foi possível iniciar:', e);
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
