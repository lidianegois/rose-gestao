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
const net = require('net');
const { createStore } = require('./storage');
const D = require('./public/docdiff.js');
const P = require('./lib/perms.js');
const AUDIT = require('./lib/audit.js');
const PL = require('./lib/plans.js');
const STK = require('./lib/stock.js');
const { makeGuard } = require('./lib/guard.js');
const V2 = process.env.RBAC_V2 !== 'off'; // interruptor de segurança: 'off' volta às regras de antes da Etapa 2
const COL = 'loja';

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

const store = (() => { try { return createStore(); } catch (e) { console.error(e.message); process.exit(1); } })();

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

/* ---------- perfis e permissões (Etapa 2): ver lib/perms.js ---------- */
let rolesCache = null;
let rolesAt = 0;
async function rolesMap(force) {
  if (force || !rolesCache || Date.now() - rolesAt > 30000) {
    const list = await store.roles();
    rolesCache = {};
    list.forEach((r) => { rolesCache[r.id] = r; });
    rolesAt = Date.now();
  }
  return rolesCache;
}
const profileOf = (u) => u.role_id || P.LEGACY[u.role] || 'caixa_atual';
/* plano da empresa: lido da configuração "plano" (sem ela, completo = como antes). PLANO_ENFORCE=off ignora o plano. */
let planoCache = null, planoAt = 0;
async function planoAtual() {
  if (process.env.PLANO_ENFORCE === 'off') return 'completo';
  if (!planoCache || Date.now() - planoAt > 5000) { const st = await store.settings(); planoCache = { plano: PL.PLANOS[process.env.PLANO_PILOTO] ? process.env.PLANO_PILOTO : PL.nome(st.plano), empresa: st.empresa_nome || 'Rose Mercearia e Bazar' }; planoAt = Date.now(); }
  return planoCache.plano;
}
async function empresaNome() { await planoAtual(); return (planoCache && planoCache.empresa) || 'Rose Mercearia e Bazar'; }
async function access(u) {
  const map = await rolesMap();
  const id = map[profileOf(u)] ? profileOf(u) : (P.LEGACY[u.role] || 'caixa_atual');
  const profile = map[id] || P.PRESETS[id];
  // o administrador sempre tem tudo, mesmo que o perfil tenha sido editado por engano
  const bruto = id === 'administrador' ? new Set(P.ALL) : P.effective(profile, u);
  const plano = await planoAtual();
  return { id, label: profile.label, set: PL.limit(plano, id, bruto, u), plano };
}
/* quem está fazendo a operação, para o histórico (nome do perfil na hora da ação) */
async function actorOf(u) {
  let perfil = roleOf(u);
  try { if (V2) perfil = (await access(u)).label; } catch (e) { /* usa o papel antigo */ }
  return { id: u.id, name: u.name, perfil };
}
/* evento administrativo no histórico. Não recebe senhas. Falha do histórico aqui não derruba a operação, mas aparece no log do servidor. */
async function aud(me, acao, alvo, registro, resumo, antes, depois, detalhe) {
  try { await store.audit([AUDIT.event(await actorOf(me), acao, alvo, registro, resumo, antes, depois, detalhe)]); } catch (e) { console.error('histórico:', e.message); }
}
const userView = (u) => ({ usuario: u.username, nome: u.name, perfil: u.role_id || u.role, ativo: u.active, arquivado: !!u.archived, conceder: u.perm_grant || [], negar: u.perm_deny || [] });
async function perms(u) {
  if (!V2) { const r = ROLES[roleOf(u)]; return { role: roleOf(u), label: r.label, tabs: r.tabs, users: r.users, data: r.data, perm: [] }; }
  const ac = await access(u);
  return { role: P.LEGACY_ROLE(ac.id), profile: ac.id, label: ac.label, tabs: P.tabsOf(ac.set), users: ac.set.has('usuarios.gerir'), data: ac.set.has('backup.copiar'), perm: [...ac.set] };
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: roleOf(u), profile: profileOf(u), perm_grant: u.perm_grant || [], perm_deny: u.perm_deny || [], active: u.active, archived: !!u.archived, created_at: u.created_at, last_login: u.last_login });
const canManageUsers = async (u) => (V2 ? (await access(u)).set.has('usuarios.gerir') : ROLES[roleOf(u)].users);
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
/* IP do cliente para o limite de tentativas. No Render, a Cloudflare grava CF-Connecting-IP (e True-Client-IP) sobrescrevendo o que o
 * cliente mandar; já o X-Forwarded-For só recebe acréscimos, então a primeira posição é controlada pelo cliente e NÃO é usada.
 * Os cabeçalhos só são aceitos quando o servidor roda atrás do Render (variável RENDER=true) ou se TRUST_CLIENT_IP_HEADERS=1;
 * fora disso (teste local, acesso direto) vale só o endereço da conexão, que não dá para forjar. */
const TRUST_IP_HEADERS = process.env.RENDER === 'true' || process.env.TRUST_CLIENT_IP_HEADERS === '1';
const IP_HEADERS = ['cf-connecting-ip', 'true-client-ip'];
function clientIp(req) {
  if (TRUST_IP_HEADERS) {
    for (const h of IP_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string' && net.isIP(v.trim())) return v.trim().toLowerCase();
    }
  }
  return String(req.socket.remoteAddress || '');
}
function tooMany(ip) {
  const a = attempts.get(ip);
  return !!a && a.n >= 10 && Date.now() - a.t < 15 * 60000;
}
function failed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.t > 15 * 60000) attempts.set(ip, { n: 1, t: Date.now() });
  else a.n++;
}

/* Camada 2: contador POR USUÁRIO, que não depende de IP nem de cabeçalho nenhum (nada que o cliente controle).
 * Os primeiros erros não esperam nada; passando do limite, cada novo erro dobra a espera (30 s, 1 min, 2 min... até 15 min).
 * Não trava definitivamente e não afeta os outros usuários. Quem já entrou antes naquele aparelho (cookie de dispositivo
 * assinado, preso ao usuário e à versão da senha) não espera, com um limite próprio bem mais alto. Nomes que não existem
 * contam igual, para não revelar quem está cadastrado. */
const WINDOW = 15 * 60000;
const ACCT_RESET = 2 * 3600000; // a conta só "esquece" os erros depois de 2 h sem novas tentativas (a espera máxima é 15 min)
const acct = new Map();
const ACCT_FREE = 20, ACCT_FREE_DEVICE = 60;
function acctWait(key) {
  const a = acct.get(key);
  if (!a) return 0;
  if (Date.now() - a.t > ACCT_RESET) { acct.delete(key); return 0; }
  return Math.max(0, a.until - Date.now());
}
function acctFail(key, free) {
  const now = Date.now();
  let a = acct.get(key);
  if (!a || now - a.t > ACCT_RESET) a = { n: 0, t: now, until: 0 };
  a.n++; a.t = now;
  if (a.n > free) a.until = now + Math.min(30000 * 2 ** Math.min(a.n - free - 1, 20), WINDOW);
  acct.delete(key); acct.set(key, a); // reinsere: o mais antigo fica no começo
  if (acct.size > 5000) acct.delete(acct.keys().next().value); // limite de memória contra nomes aleatórios
}
const tooManyMsg = (ms) => `Muitas tentativas para este usuário. Tente de novo em ${Math.ceil(ms / 60000) > 1 ? Math.ceil(ms / 60000) + ' minutos' : Math.max(1, Math.ceil(ms / 1000)) + ' segundos'}.`;

const DEVICE_COOKIE = 'rose_disp', DEVICE_DAYS = 90;
const deviceSign = (payload) => sign('disp:' + payload); // separado da assinatura da sessão
function makeDeviceCookie(u, req) {
  const payload = Buffer.from(JSON.stringify({ id: u.id, v: u.pwv, e: Date.now() + DEVICE_DAYS * 864e5 })).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' ? '; Secure' : '';
  return `${DEVICE_COOKIE}=${payload}.${deviceSign(payload)}; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_DAYS * 86400}${secure}`;
}
function knownDevice(req, u) {
  if (!u) return false;
  const raw = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(DEVICE_COOKIE + '='));
  if (!raw) return false;
  const [payload, sig] = raw.slice(DEVICE_COOKIE.length + 1).split('.');
  if (!payload || !sig) return false;
  const good = deviceSign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d && d.id === u.id && d.v === u.pwv && d.e > Date.now();
  } catch (e) { return false; }
}

/* ---------- conta ---------- */
async function handleLogin(req, res) {
  const body = await readJson(req, 10000);
  const username = String(body.usuario || '').trim().toLowerCase().slice(0, 60);
  const pass = String(body.senha || '');
  const ip = clientIp(req) + '|' + username; // camada 1: por endereço E usuário, então quem divide a rede da loja não bloqueia os colegas
  if (tooMany(ip)) return send(res, 429, { error: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
  const u = (await users(true)).find((x) => x.username === username);
  const device = knownDevice(req, u);
  const key = (device ? 'd:' : 'u:') + username; // camada 2
  const wait = acctWait(key);
  if (wait > 0) return send(res, 429, { error: tooManyMsg(wait) }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
  const ok = await checkPassword(pass, u ? u.pass : DUMMY_HASH);
  if (!u || !ok) {
    failed(ip);
    acctFail(key, device ? ACCT_FREE_DEVICE : ACCT_FREE);
    return send(res, 401, { error: 'Usuário ou senha incorretos.' });
  }
  if (!u.active) return send(res, 403, { error: 'Este usuário está desativado. Fale com a administradora.' });
  attempts.delete(ip);
  acct.delete('d:' + username);
  if (!device) acct.delete('u:' + username); // aparelho conhecido não zera a espera imposta a quem chuta senhas de fora
  store.updateUser(u.id, { last_login: new Date().toISOString() }).catch(() => {});
  return send(res, 200, { ok: true, user: publicUser(u) }, { 'Set-Cookie': [makeCookie(u, req), makeDeviceCookie(u, req)] });
}

async function handleOwnPassword(req, res, me) {
  const b = await readJson(req, 10000);
  if (!(await checkPassword(String(b.atual || ''), me.pass))) return send(res, 400, { error: 'A senha atual não confere.' });
  const pass = String(b.nova || '');
  if (pass.length < 8) return send(res, 400, { error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  await store.updateUser(me.id, { pass: await hashPassword(pass), pwv: me.pwv + 1 });
  await aud(me, 'senha_propria', 'usuarios', me.id, me.name + ' trocou a própria senha', null, null);
  const fresh = (await users(true)).find((x) => x.id === me.id);
  return send(res, 200, { ok: true }, { 'Set-Cookie': makeCookie(fresh, req) });
}

// /api/usuarios (GET lista, POST cria) e /api/usuarios/<id> (PATCH altera). Só quem tem a permissão usuarios.gerir.
const validPerms = (l) => (Array.isArray(l) ? [...new Set(l.filter((p) => P.ALL.includes(p)))] : []);
async function handleUsers(req, res, me, id) {
  if (!(await canManageUsers(me))) return send(res, 403, { error: 'Só a administradora pode gerenciar usuários.' });
  const all = await users(true);
  const map = await rolesMap(true);
  const isAdminU = async (x) => (await access(x)).set.has('usuarios.gerir');
  const activeAdmins = async () => { let n = 0; for (const x of all) if (x.active && (await isAdminU(x))) n++; return n; };
  if (!id && req.method === 'GET') return send(res, 200, { users: all.map(publicUser) });
  if (!id && req.method === 'POST') {
    const b = await readJson(req, 10000);
    const username = String(b.usuario || '').trim().toLowerCase();
    const name = String(b.nome || '').trim().slice(0, 60);
    const pass = String(b.senha || '');
    let role_id = String(b.perfil || '');
    if (PL.PERFIS_INTERNOS.includes(role_id) && (await planoAtual()) !== 'completo') return send(res, 400, { error: 'Perfil de uso interno não pode ser usado neste plano.' });
    if (!map[role_id]) role_id = b.papel === 'admin' ? 'administrador' : b.papel === 'gerente' ? 'gerente_atual' : 'caixa_vendas';
    if (PL.PERFIS_INTERNOS.includes(role_id) && (await planoAtual()) !== 'completo') return send(res, 400, { error: 'Perfil de uso interno não pode ser usado neste plano.' });
    if (!USERNAME.test(username)) return send(res, 400, { error: 'O usuário precisa ter de 3 a 30 caracteres: letras minúsculas, números, ponto, traço ou sublinhado, sem espaços.' });
    if (!name) return send(res, 400, { error: 'Informe o nome.' });
    if (pass.length < 8) return send(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (all.some((x) => x.username === username)) return send(res, 409, { error: 'Já existe um usuário com esse nome de acesso.' });
    const u = { id: 'u' + crypto.randomBytes(6).toString('hex'), username, name, pass: await hashPassword(pass), role: P.LEGACY_ROLE(role_id), role_id, perm_grant: validPerms(b.conceder), perm_deny: validPerms(b.negar), active: true, pwv: 1 };
    await store.createUser(u);
    await users(true);
    await aud(me, 'usuario_criar', 'usuarios', u.id, 'Usuário ' + u.username + ' criado', null, userView(u));
    return send(res, 201, { user: publicUser(u) });
  }
  if (id && req.method === 'PATCH') {
    const u = all.find((x) => x.id === id);
    if (!u) return send(res, 404, { error: 'Usuário não encontrado.' });
    const b = await readJson(req, 10000);
    const f = {};
    const wasAdmin = await isAdminU(u);
    const isLastAdmin = wasAdmin && u.active && (await activeAdmins()) === 1;
    if (b.nome !== undefined) {
      const name = String(b.nome).trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'Informe o nome.' });
      f.name = name;
    }
    if (b.perfil !== undefined || b.papel !== undefined || b.conceder !== undefined || b.negar !== undefined) {
      let role_id = b.perfil !== undefined ? String(b.perfil) : profileOf(u);
      if (b.perfil === undefined && b.papel !== undefined) role_id = b.papel === 'admin' ? 'administrador' : b.papel === 'gerente' ? 'gerente_atual' : b.papel === 'caixa' ? 'caixa_atual' : '';
      if (!map[role_id]) return send(res, 400, { error: 'Perfil inválido.' });
      const next = { ...u, role_id, perm_grant: b.conceder !== undefined ? validPerms(b.conceder) : u.perm_grant || [], perm_deny: b.negar !== undefined ? validPerms(b.negar) : u.perm_deny || [] };
      if (wasAdmin && !(await access(next)).set.has('usuarios.gerir') && (isLastAdmin || u.id === me.id)) return send(res, 400, { error: 'É preciso ter pelo menos uma administradora ativa.' });
      if (PL.PERFIS_INTERNOS.includes(role_id) && (await planoAtual()) !== 'completo') return send(res, 400, { error: 'Perfil de uso interno não pode ser usado neste plano.' });
      f.role_id = role_id;
      f.role = P.LEGACY_ROLE(role_id);
      f.perm_grant = next.perm_grant;
      f.perm_deny = next.perm_deny;
      f.pwv = u.pwv + 1; // as permissões mudam: a pessoa precisa entrar de novo
    }
    if (b.ativo !== undefined) {
      const active = !!b.ativo;
      if (!active && u.id === me.id) return send(res, 400, { error: 'Você não pode desativar a sua própria conta.' });
      if (!active && isLastAdmin) return send(res, 400, { error: 'É preciso ter pelo menos uma administradora ativa.' });
      f.active = active;
      if (active) f.archived = false; // reativar tira do arquivo
      if (!active) f.pwv = u.pwv + 1; // derruba as sessões abertas
    }
    if (b.arquivado !== undefined) {
      const arq = !!b.arquivado;
      if (arq && u.id === me.id) return send(res, 400, { error: 'Você não pode arquivar a sua própria conta.' });
      if (arq && isLastAdmin) return send(res, 400, { error: 'É preciso ter pelo menos uma administradora ativa.' });
      f.archived = arq;
      if (arq) { f.active = false; f.pwv = u.pwv + 1; } // arquivar também desativa e derruba as sessões
    }
    if (b.senha !== undefined) {
      const pass = String(b.senha);
      if (pass.length < 8) return send(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
      f.pass = await hashPassword(pass);
      f.pwv = u.pwv + 1;
    }
    await store.updateUser(u.id, f);
    const fresh = (await users(true)).find((x) => x.id === u.id);
    {
      const acao = f.archived === true ? 'usuario_arquivar' : f.archived === false && u.archived ? 'usuario_reativar' : f.pass ? 'usuario_senha' : f.active === false ? 'usuario_desativar' : f.active === true ? 'usuario_ativar' : 'usuario_alterar';
      const antes = userView(u), depois = userView(fresh);
      await aud(me, acao, 'usuarios', u.id, 'Usuário ' + u.username + ' (' + acao.replace('usuario_', '').replace('senha', 'senha redefinida') + ')', antes, depois, f.pass ? { senha_redefinida: true } : null);
    }
    const headers = fresh.id === me.id && f.pwv ? { 'Set-Cookie': makeCookie(fresh, req) } : {};
    return send(res, 200, { user: publicUser(fresh) }, headers);
  }
  if (id && req.method === 'DELETE') {
    const u = all.find((x) => x.id === id);
    if (!u) return send(res, 404, { error: 'Usuário não encontrado.' });
    if (u.id === me.id) return send(res, 400, { error: 'Você não pode excluir a sua própria conta.' });
    if (u.active) return send(res, 400, { error: 'Desative ou arquive o usuário antes de excluir.' });
    await store.deleteUser(u.id);
    await users(true);
    await aud(me, 'usuario_excluir', 'usuarios', u.id, 'Usuário ' + u.username + ' excluído', userView(u), null);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'método não permitido' });
}

// /api/perfis: lista (qualquer usuário gerente de usuários), cria e edita perfis
async function handleRoles(req, res, me, id) {
  if (!(await canManageUsers(me))) return send(res, 403, { error: 'Só a administradora pode gerenciar perfis.' });
  const map = await rolesMap(true);
  if (!id && req.method === 'GET') return send(res, 200, { perfis: Object.values(map).map((r) => ({ id: r.id, label: r.label, perms: r.perms, system: r.system })), catalogo: P.CATALOG });
  if (req.method === 'POST' && !id) {
    const b = await readJson(req, 20000);
    const label = String(b.nome || '').trim().slice(0, 40);
    if (!label) return send(res, 400, { error: 'Informe o nome do perfil.' });
    const nid = 'p_' + crypto.randomBytes(4).toString('hex');
    await store.saveRole({ id: nid, label, perms: validPerms(b.perms), system: false });
    await rolesMap(true);
    await aud(me, 'perfil_criar', 'perfis', nid, 'Perfil ' + label + ' criado', null, { nome: label, perms: validPerms(b.perms) });
    return send(res, 201, { ok: true, id: nid });
  }
  if (req.method === 'PUT' && id) {
    const r = map[id];
    if (!r) return send(res, 404, { error: 'Perfil não encontrado.' });
    if (id === 'administrador') return send(res, 400, { error: 'O perfil Administrador sempre tem todas as permissões.' });
    const b = await readJson(req, 20000);
    const perms = validPerms(b.perms);
    // quem tem a permissão de gerir usuários precisa continuar existindo
    if (r.perms.includes('usuarios.gerir') && !perms.includes('usuarios.gerir')) return send(res, 400, { error: 'Este perfil não pode perder o gerenciamento de usuários.' });
    await store.saveRole({ id, label: b.nome ? String(b.nome).trim().slice(0, 40) : r.label, perms, system: r.system });
    await rolesMap(true);
    await aud(me, 'perfil_alterar', 'perfis', id, 'Perfil ' + r.label + ' alterado', { nome: r.label, perms: r.perms }, { nome: b.nome ? String(b.nome).trim().slice(0, 40) : r.label, perms });
    await users(true);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'método não permitido' });
}

/* ---------- proteção de estoque: relatório, modo e autorização de exceção ---------- */
const usedTokens = new Set();
function makeExcecaoToken(admin, requester, just) {
  const p = Buffer.from(JSON.stringify({ a: admin.id, an: admin.name, j: just, r: requester.id, n: crypto.randomBytes(6).toString('hex'), e: Date.now() + 10 * 60000 })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readExcecao(token, me) {
  if (!token || typeof token !== 'string') return null;
  const [p, sg] = token.split('.');
  if (!p || !sg || sg !== sign(p)) return null;
  let d;
  try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { return null; }
  if (!d || d.e < Date.now() || d.r !== me.id) return null;
  return { adminId: d.a, nome: d.an, justificativa: d.j, nonce: d.n };
}
async function handleEstoque(req, res, parts, me) {
  const ac = await access(me);
  const settings = await store.settings();
  const modo = settings.estoque_modo || 'aviso';
  const sub = parts[2];
  if (sub === 'relatorio' && req.method === 'GET') {
    if (!ac.set.has('estoque.conferir')) return send(res, 403, { error: 'Seu perfil não pode ver a conferência de estoque.' });
    const docs = await store.stockDocs(COL);
    const rep = STK.report(docs, (docs.cadastros && docs.cadastros.produtos) || []);
    const log = await store.stockLogList(1000);
    const desde = settings.estoque_aviso_desde || null;
    const dias = desde ? Math.floor((Date.now() - new Date(desde).getTime()) / 864e5) : null;
    const porProduto = {};
    log.filter((l) => l.kind === 'aviso').forEach((l) => { porProduto[l.product_id] = (porProduto[l.product_id] || 0) + 1; });
    return send(res, 200, { modo, desde, dias, linhas: rep.linhas.map((l) => ({ ...l, avisos: porProduto[l.id] || 0 })), produtosDesconhecidos: rep.produtosDesconhecidos, registro: log.slice(0, 200) });
  }
  if (sub === 'modo' && req.method === 'POST') {
    if (!ac.set.has('estoque.excecao')) return send(res, 403, { error: 'Só a administradora muda o modo de proteção do estoque.' });
    const b = await readJson(req, 2000);
    if (!['off', 'aviso', 'bloqueio'].includes(b.modo)) return send(res, 400, { error: 'Modo inválido.' });
    if (b.modo === 'bloqueio' && b.confirmo !== true) return send(res, 400, { error: 'Confirme que os saldos foram conferidos antes de ligar o bloqueio.' });
    const modoAntes = (await store.settings()).estoque_modo;
    await store.setSetting('estoque_modo', b.modo);
    await aud(me, 'config', 'estoque', 'estoque_modo', 'Proteção de estoque: ' + modoAntes + ' → ' + b.modo, modoAntes, b.modo);
    if (b.modo === 'aviso') await store.setSetting('estoque_aviso_desde', new Date().toISOString());
    return send(res, 200, { ok: true, modo: b.modo });
  }
  if (sub === 'checar' && req.method === 'POST') {
    if (!['caixa.vender', 'vendas.editar', 'estoque.movimentar', 'compras.receber'].some((p) => ac.set.has(p))) return send(res, 403, { error: 'Sem permissão.' });
    const b = await readJson(req, 100000);
    const want = {};
    (Array.isArray(b.itens) ? b.itens : []).forEach((i) => { if (Array.isArray(i)) want[String(i[0])] = (want[String(i[0])] || 0) + (+i[1] || 0); });
    const docs = await store.stockDocs(COL);
    const prods = (docs.cadastros && docs.cadastros.produtos) || [];
    const st = STK.saldos(docs, prods);
    const nomes = {};
    prods.forEach((p) => { nomes[p.id] = p.nome; });
    const itens = Object.keys(want).filter((pid) => pid in st && st[pid] - want[pid] < -1e-9).map((pid) => ({ pid, nome: nomes[pid], saldo: st[pid], consumo: want[pid] }));
    return send(res, 200, { modo, itens });
  }
  if (sub === 'autorizar' && req.method === 'POST') {
    const ip = clientIp(req) + '|exc';
    const who = 'exc:' + me.id; // quem pede já está autenticado: o limite por pessoa não depende de IP nem de cabeçalhos
    if (tooMany(ip) || tooMany(who)) return send(res, 429, { error: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
    const b = await readJson(req, 5000);
    const just = String(b.justificativa || '').trim();
    if (just.length < 5) return send(res, 400, { error: 'Escreva a justificativa (pelo menos 5 caracteres).' });
    const a = (await users(true)).find((x) => x.username === String(b.usuario || '').trim().toLowerCase());
    const ok = await checkPassword(String(b.senha || ''), a ? a.pass : DUMMY_HASH);
    if (!a || !ok || !a.active || !(await access(a)).set.has('estoque.excecao')) { failed(ip); failed(who); return send(res, 403, { error: 'Usuário ou senha de administrador incorretos.' }); }
    await aud(me, 'estoque_excecao', 'estoque', a.id, a.name + ' autorizou uma exceção de estoque para ' + me.name, null, null, { justificativa: just });
    return send(res, 200, { token: makeExcecaoToken(a, me, just), por: a.name });
  }
  return send(res, 404, { error: 'não encontrado' });
}

/* ---------- dados ---------- */
async function handleData(req, res, parts, me) {
  // parts: ['api','col',<col>] ou ['api','col',<col>,'_version'] ou ['api','col',<col>,<id>]
  const col = parts[2];
  if (!col || !SEG.test(col)) return send(res, 400, { error: 'coleção inválida' });
  const ac = V2 ? await access(me) : null;
  const legacy = ROLES[roleOf(me)];
  const actor = { id: me.id, name: me.name, perfil: ac ? ac.label : legacy.label };
  if (parts.length === 3 && req.method === 'GET') {
    const [docs, version] = await Promise.all([store.list(col), store.version()]);
    if (!V2) return send(res, 200, { version, docs });
    // leitura filtrada no servidor: o que o perfil não enxerga nunca sai daqui
    let extra = null;
    if (col === COL && P.needsSaldos(ac.set)) {
      const sd = await store.stockDocs(COL);
      extra = { saldos: STK.saldos(sd, (sd.cadastros && sd.cadastros.produtos) || []) };
    }
    return send(res, 200, { version, docs: docs.map((d) => ({ ...d, data: P.filterDoc(d.id, d.data, ac.set, d.id === 'cadastros' ? extra : null) })) });
  }
  if (parts.length === 4 && parts[3] === '_version' && req.method === 'GET') {
    return send(res, 200, { version: await store.version() });
  }
  // opções de gravação: proteção de estoque e permissões dentro da transação
  const guardFor = async (excecaoToken, bulk) => {
    const settings = await store.settings();
    let excecao = null;
    if (excecaoToken) {
      excecao = readExcecao(excecaoToken, me);
      if (!excecao || usedTokens.has(excecao.nonce)) throw Object.assign(new Error('A autorização do administrador expirou ou já foi usada.'), { status: 403 });
    }
    return { excecao, guard: makeGuard({ set: ac.set, user: me, settings, excecao, skipStock: bulk }) };
  };
  const answerAbort = (out) => {
    const a = out.abort;
    if (a.code === 'estoque') return send(res, 409, { error: 'Estoque insuficiente.', code: 'estoque_insuficiente', itens: a.itens });
    return send(res, 403, { error: a.message || 'Sem permissão.' });
  };
  if (parts.length === 4 && parts[3] === '_batch' && req.method === 'POST') {
    // várias mudanças de uma vez, numa só transação: { docs: { <documento>: [mudanças] }, bulk?: true, excecao?: token }
    const body = await readJson(req, 20 * 1024 * 1024);
    const docs = body && body.docs;
    if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return send(res, 400, { error: 'lote inválido' });
    const ids = Object.keys(docs);
    if (!ids.length || ids.length > 100) return send(res, 400, { error: 'lote inválido' });
    for (const id of ids) {
      if (!SEG.test(id) || id === '.' || id === '..' || !Array.isArray(docs[id])) return send(res, 400, { error: 'documento inválido no lote' });
      if (!V2 && !legacy.write.test(id)) return send(res, 403, { error: `O perfil ${legacy.label} não pode alterar esta parte do sistema.` });
      if (!V2 && !legacy.del && docs[id].some((o) => o && (o.op === 'del' || o.op === 'list'))) return send(res, 403, { error: `O perfil ${legacy.label} não pode apagar registros.` });
    }
    if (!V2) {
      const out = await store.applyBatch(col, docs, { bulk: body.bulk === true && roleOf(me) === 'admin', actor });
      if (!out.ok) return send(res, 409, { error: 'Outra pessoa alterou os mesmos registros.', conflicts: out.conflicts });
      return send(res, 200, { version: out.version || (await store.version()), assigned: out.assigned, changed: out.changed });
    }
    const bulk = body.bulk === true;
    if (bulk && !(ac.set.has('backup.restaurar') || ac.set.has('dados.apagar'))) return send(res, 403, { error: 'Só a administradora pode importar ou restaurar dados.' });
    const pre = bulk ? null : P.checkWrite(ac.set, docs); // recusa cedo, sem abrir transação
    if (pre) return send(res, 403, { error: pre });
    const g = await guardFor(body.excecao, bulk);
    const out = await store.applyBatch(col, docs, { bulk, guard: bulk ? null : g.guard, actor });
    if (out.abort) return answerAbort(out);
    if (!out.ok) return send(res, 409, { error: 'Outra pessoa alterou os mesmos registros.', conflicts: out.conflicts });
    if (g.excecao) usedTokens.add(g.excecao.nonce);
    return send(res, 200, { version: out.version || (await store.version()), assigned: out.assigned, changed: out.changed });
  }
  if (parts.length === 4) {
    const id = parts[3];
    if (!SEG.test(id) || id === '.' || id === '..') return send(res, 400, { error: 'documento inválido' });
    if (!V2 && ((req.method === 'PUT' && !legacy.write.test(id)) || (req.method === 'DELETE' && !legacy.del))) {
      return send(res, 403, { error: `O perfil ${legacy.label} não pode alterar esta parte do sistema.` });
    }
    if (req.method === 'PUT') {
      // gravação do documento inteiro (compatibilidade): vira um lote de diferenças e passa pelas mesmas regras
      const data = await readJson(req);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'o corpo precisa ser um objeto JSON' });
      if (!V2) {
        try {
          const out = await store.applyBatch(col, {
            [id]: (cur) => {
              const ops = D.diffDoc(id, cur, data);
              if (!legacy.del && ops.some((o) => o.op === 'del' || o.op === 'list')) throw Object.assign(new Error('sem permissão'), { perm: true });
              return ops;
            },
          }, { actor });
          return send(res, 200, { version: out.version || (await store.version()) });
        } catch (e) {
          if (e && e.perm) return send(res, 403, { error: `O perfil ${legacy.label} não pode apagar registros.` });
          throw e;
        }
      }
      const g = await guardFor(null, false);
      const out = await store.applyBatch(col, { [id]: (cur) => D.diffDoc(id, cur, data) }, { guard: g.guard, actor });
      if (out.abort) return answerAbort(out);
      return send(res, 200, { version: out.version || (await store.version()) });
    }
    if (req.method === 'DELETE') {
      // a tela apaga o documento de um mês quando o último registro dele sai: vira "apagar cada registro", com as mesmas regras
      const mes = /^(vendas|notas)-\d{4}-\d{2}$/.test(id);
      if (V2 && mes && !ac.set.has('dados.apagar')) {
        const g = await guardFor(null, false);
        const out = await store.applyBatch(col, { [id]: (cur) => ((cur && cur.items) || []).map((r) => ({ k: 'items', op: 'del', id: String(r.id), before: r })) }, { guard: g.guard, actor });
        if (out.abort) return answerAbort(out);
        return send(res, 200, { version: out.version || (await store.version()) });
      }
      if (V2 && !ac.set.has('dados.apagar')) return send(res, 403, { error: 'Seu perfil não pode apagar documentos.' });
      return send(res, 200, { version: await store.remove(col, id, { actor }) });
    }
  }
  return send(res, 405, { error: 'método não permitido' });
}

/* ---------- histórico de alterações (somente leitura) ---------- */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
async function handleHistorico(req, res, me, id) {
  const ok = V2 ? (await access(me)).set.has('auditoria.ver') : roleOf(me) === 'admin';
  if (!ok) return send(res, 403, { error: 'Seu perfil não pode ver o histórico.' });
  if (req.method !== 'GET') return send(res, 405, { error: 'O histórico só pode ser consultado.' });
  if (id) {
    if (!/^\d{1,12}$/.test(id)) return send(res, 400, { error: 'registro inválido' });
    const r = await store.auditGet(id);
    return r ? send(res, 200, { item: r }) : send(res, 404, { error: 'Registro do histórico não encontrado.' });
  }
  const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  if ((q.de && !ISO_DAY.test(q.de)) || (q.ate && !ISO_DAY.test(q.ate))) return send(res, 400, { error: 'Data inválida.' });
  const items = await store.auditList({ alvo: q.alvo, registro: q.registro, user: q.usuario, acao: q.acao, de: q.de, ate: q.ate, q: q.q, antes_de: q.antes_de, limit: q.limite });
  return send(res, 200, { items, total: await store.auditCount() });
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
      if (parts[1] === 'me' && parts.length === 2 && req.method === 'GET') return send(res, 200, { user: { ...publicUser(me), ...(await perms(me)), plano: await planoAtual(), empresa: await empresaNome() } });
      if (parts[1] === 'senha' && parts.length === 2 && req.method === 'POST') return await handleOwnPassword(req, res, me);
      if (parts[1] === 'perfis' && parts.length <= 3) return await handleRoles(req, res, me, parts[2]);
      if (parts[1] === 'estoque') return await handleEstoque(req, res, parts, me);
      if (parts[1] === 'historico' && parts.length <= 3) return await handleHistorico(req, res, me, parts[2]);
      if (parts[1] === 'usuarios' && parts.length <= 3) return await handleUsers(req, res, me, parts[2]);
      if (parts[1] === 'col') return await handleData(req, res, parts, me);
      return send(res, 404, { error: 'não encontrado' });
    }
    if (p === '/' || p === '/index.html') return serveFile(req, res, '/index.html');
    if (p === '/usuarios') return (await canManageUsers(me)) ? serveFile(req, res, '/usuarios.html') : redirect(res, '/');
    if (p === '/estoque-conferencia') return (V2 ? (await access(me)).set.has('estoque.conferir') : ROLES[roleOf(me)].users) ? serveFile(req, res, '/conferencia.html') : redirect(res, '/');
    if (p === '/historico') return (V2 ? (await access(me)).set.has('auditoria.ver') : roleOf(me) === 'admin') ? serveFile(req, res, '/historico.html') : redirect(res, '/');
    if (p === '/login.html' || p === '/usuarios.html' || p === '/conferencia.html' || p === '/historico.html') return redirect(res, '/');
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
  await store.createUser({ id: 'u' + crypto.randomBytes(6).toString('hex'), username, name: process.env.APP_NAME || 'Rose', pass: await hashPassword(pass), role: 'admin', role_id: 'administrador', active: true, pwv: 1 });
  await users(true);
  console.log(`Primeira administradora criada: ${username}`);
}

/* Piloto (serviço de teste): com TI_SENHA e plano completo, cria a conta individual TI-Lidiane uma única vez.
 * A senha só é usada nessa criação (quem já existe não é alterado) e nunca é impressa. */
async function bootstrapTi() {
  const senha = process.env.TI_SENHA;
  if (!senha) return;
  if ((await planoAtual()) !== 'completo') { console.warn('TI_SENHA ignorada: a conta TI-Lidiane só é criada no plano completo.'); return; }
  if (senha.length < 8) { console.warn('TI_SENHA ignorada: use pelo menos 8 caracteres.'); return; }
  const username = String(process.env.TI_USUARIO || 'ti-lidiane').trim().toLowerCase();
  if ((await users(true)).some((u) => u.username === username)) return;
  await store.saveRole(PL.TI_LIDIANE);
  await store.createUser({ id: 'u' + crypto.randomBytes(6).toString('hex'), username, name: 'TI-Lidiane', pass: await hashPassword(senha), role: P.LEGACY_ROLE('ti_lidiane'), role_id: 'ti_lidiane', perm_grant: [], perm_deny: [], active: true, pwv: 1 });
  await users(true);
  console.log(`Conta ${username} criada.`);
}

store
  .init()
  .then(bootstrapAdmin)
  .then(bootstrapTi)
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
