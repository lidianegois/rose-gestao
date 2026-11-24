'use strict';
/* Limite de tentativas SEM confiar em cabeçalhos do cliente (camada por usuário + dispositivo conhecido + isolamento por IP/usuário).
 * Cenários: cabeçalhos falsificados, ausentes, inválidos, acesso direto à origem (cliente controla CF-Connecting-IP), rede
 * compartilhada da loja, dispositivo conhecido, sessões e senhas existentes. Ambiente local isolado (armazenamento em arquivo).
 * Uso: node test/login-forjado.test.js [pasta-do-codigo-anterior] */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const SECRET = 'segredo-de-teste';
const copy = (src) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'code-')); fs.cpSync(src, t, { recursive: true, filter: (f) => !/node_modules|\.git(\/|$)|\/data(\/|$)/.test(f) }); return t; };
const stop = (proc) => new Promise((r) => { proc.kill(); setTimeout(r, 300); });
async function start(dir, port, env) {
  const proc = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), APP_USER: 'adm', APP_PASSWORD: 'senha12345', SESSION_SECRET: SECRET, DATABASE_URL: '', ...env }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) return { proc, base }; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu');
}
const post = (base, url, body, h) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(h || {}) }, body: JSON.stringify(body) });
const login = (base, user, senha, h) => post(base, '/api/login', { usuario: user, senha }, h);
const cookiesOf = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).map((c) => c.split(';')[0]);
const jar = (r) => cookiesOf(r).join('; ');
async function tentativas(base, user, n, h) { const out = []; for (let i = 0; i < n; i++) out.push((await login(base, user, 'errada-123', typeof h === 'function' ? h(i) : h)).status); return out; }
async function criaUsuarios(base) {
  const ck = jar(await login(base, 'adm', 'senha12345', { 'cf-connecting-ip': '198.51.100.250' }));
  for (const u of ['ana', 'bia', 'caio']) await post(base, '/api/usuarios', { usuario: u, nome: u, senha: 'senha-' + u + '-123', perfil: 'caixa_vendas' }, { cookie: ck });
  return ck;
}

(async () => {
  const dir = path.join(__dirname, '..');
  const code = copy(dir);

  /* ===== A. ACESSO DIRETO À ORIGEM: o atacante controla CF-Connecting-IP e X-Forwarded-For (RENDER=true confia no cabeçalho) ===== */
  let { proc, base } = await start(code, 3401, { RENDER: 'true' });
  await criaUsuarios(base);
  let r = await tentativas(base, 'adm', 45, (i) => ({ 'cf-connecting-ip': `203.0.113.${(i % 250) + 1}`, 'x-forwarded-for': `9.9.${i}.1` }));
  const livres = r.filter((s) => s === 401).length;
  ok('origem direta: IP forjado a cada tentativa NÃO dá tentativas ilimitadas (no máximo 21 erros processados)', livres <= 21 && r.slice(22).every((s) => s === 429), r);
  const certa = await login(base, 'adm', 'senha12345', { 'cf-connecting-ip': '203.0.113.200' });
  ok('durante a espera nem a senha certa entra por um IP novo (não revela se acertou)', certa.status === 429);
  ok('a resposta traz Retry-After', Number(certa.headers.get('retry-after')) > 0, certa.headers.get('retry-after'));
  ok('mensagem não promete bloqueio eterno: diz quanto esperar', /Tente de novo em/.test((await certa.json()).error));
  // isolamento: outros usuários seguem entrando, mesmo vindo da mesma rede
  for (const u of ['ana', 'bia', 'caio']) ok('outro usuário (' + u + ') não é afetado pela espera do adm', (await login(base, u, 'senha-' + u + '-123', { 'cf-connecting-ip': '203.0.113.7' })).status === 200);
  // nome inexistente gasta o mesmo contador e não revela cadastro
  r = await tentativas(base, 'fantasma', 30, (i) => ({ 'cf-connecting-ip': `198.18.${i}.9` }));
  ok('usuário inexistente recebe o mesmo tratamento (sem revelar se existe)', r.slice(22).every((s) => s === 429) && r[0] === 401, r);
  // muitos nomes aleatórios não derrubam o servidor nem o login de quem existe
  for (let i = 0; i < 300; i++) await login(base, 'x' + i, 'errada-123', { 'cf-connecting-ip': '198.19.0.' + (i % 250 + 1) });
  ok('centenas de nomes aleatórios não derrubam o servidor', (await login(base, 'ana', 'senha-ana-123', { 'cf-connecting-ip': '203.0.113.8' })).status === 200);
  await stop(proc);

  /* ===== B. REDE COMPARTILHADA DA LOJA: mesmo IP público, vários funcionários ===== */
  ({ proc, base } = await start(code, 3402, { RENDER: 'true' }));
  await criaUsuarios(base);
  const LOJA = { 'cf-connecting-ip': '203.0.113.99' };
  for (const u of ['adm', 'ana', 'bia']) await tentativas(base, u, 4, LOJA); // 12 erros no mesmo IP, em contas diferentes
  const logins = [];
  for (const [u, s] of [['adm', 'senha12345'], ['ana', 'senha-ana-123'], ['bia', 'senha-bia-123'], ['caio', 'senha-caio-123']]) logins.push((await login(base, u, s, LOJA)).status);
  ok('12 erros somados de 3 funcionários no mesmo IP NÃO bloqueiam ninguém (todos entram)', logins.every((s) => s === 200), logins);
  r = await tentativas(base, 'ana', 11, LOJA);
  ok('a mesma conta errando 10 vezes no mesmo IP continua sendo limitada (11ª = 429)', r[9] === 401 && r[10] === 429, r);
  ok('...e os colegas do mesmo IP seguem entrando', (await login(base, 'bia', 'senha-bia-123', LOJA)).status === 200);
  await stop(proc);

  /* ===== C. DISPOSITIVO CONHECIDO ===== */
  ({ proc, base } = await start(code, 3403, { RENDER: 'true' }));
  await criaUsuarios(base);
  const l1 = await login(base, 'ana', 'senha-ana-123', { 'cf-connecting-ip': '203.0.113.11' });
  const disp = cookiesOf(l1).find((c) => c.startsWith('rose_disp='));
  ok('login correto entrega cookie de sessão e cookie de dispositivo', l1.status === 200 && !!disp && cookiesOf(l1).some((c) => c.startsWith('rose_sessao=')), cookiesOf(l1).map((c) => c.slice(0, 12)));
  ok('cookie de dispositivo só vai para /api/login e é HttpOnly', /Path=\/api\/login/.test(l1.headers.getSetCookie().find((c) => c.startsWith('rose_disp='))) && /HttpOnly/.test(l1.headers.getSetCookie().find((c) => c.startsWith('rose_disp='))));
  await tentativas(base, 'ana', 45, (i) => ({ 'cf-connecting-ip': `198.51.${i}.7` })); // atacante sem cookie esgota a espera da conta
  ok('atacante sem cookie fica em espera', (await login(base, 'ana', 'senha-ana-123', { 'cf-connecting-ip': '198.51.100.1' })).status === 429);
  ok('o aparelho conhecido da própria Ana continua entrando durante o ataque', (await login(base, 'ana', 'senha-ana-123', { cookie: disp, 'cf-connecting-ip': '203.0.113.11' })).status === 200);
  const dBia = cookiesOf(await login(base, 'bia', 'senha-bia-123', { 'cf-connecting-ip': '203.0.113.12' })).find((c) => c.startsWith('rose_disp='));
  await tentativas(base, 'ana', 3, (i) => ({ 'cf-connecting-ip': `198.52.${i}.7` }));
  ok('cookie de dispositivo de OUTRA pessoa não vale para a Ana', (await login(base, 'ana', 'senha-ana-123', { cookie: dBia, 'cf-connecting-ip': '198.51.100.2' })).status === 429);
  const adulterado = disp.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  ok('cookie de dispositivo adulterado não vale', (await login(base, 'ana', 'senha-ana-123', { cookie: adulterado, 'cf-connecting-ip': '198.51.100.3' })).status === 429);
  const sessao = cookiesOf(l1).find((c) => c.startsWith('rose_sessao='));
  ok('cookie de SESSÃO não serve como cookie de dispositivo', (await login(base, 'ana', 'senha-ana-123', { cookie: 'rose_disp=' + sessao.split('=')[1], 'cf-connecting-ip': '198.51.100.4' })).status === 429);
  // trocar a senha invalida os dispositivos conhecidos
  const ckAna = jar(await login(base, 'ana', 'senha-ana-123', { cookie: disp, 'cf-connecting-ip': '203.0.113.11' }));
  ok('Ana troca a própria senha', (await post(base, '/api/senha', { atual: 'senha-ana-123', nova: 'senha-nova-9999' }, { cookie: ckAna })).status === 200);
  ok('após trocar a senha, o cookie de dispositivo antigo deixa de valer', (await login(base, 'ana', 'senha-nova-9999', { cookie: disp, 'cf-connecting-ip': '198.51.100.5' })).status === 429);
  // o aparelho conhecido também tem teto próprio
  const dC = cookiesOf(await login(base, 'caio', 'senha-caio-123', { 'cf-connecting-ip': '203.0.113.13' })).find((c) => c.startsWith('rose_disp='));
  r = await tentativas(base, 'caio', 90, (i) => ({ cookie: dC, 'cf-connecting-ip': `192.0.2.${(i % 250) + 1}` }));
  ok('cookie de dispositivo roubado NÃO dá tentativas ilimitadas (teto próprio de 60)', r.filter((s) => s === 401).length <= 61 && r.slice(62).every((s) => s === 429), r.filter((s) => s === 401).length);
  await stop(proc);

  /* ===== D. CABEÇALHOS AUSENTES / INVÁLIDOS / FORA DO RENDER ===== */
  ({ proc, base } = await start(code, 3404, { RENDER: 'true' }));
  await criaUsuarios(base);
  r = await tentativas(base, 'adm', 45, (i) => ({ 'cf-connecting-ip': ['lixo', '1.1.1.1, 2.2.2.2', '1.2.3.4:80', ''][i % 4], 'x-forwarded-for': `7.7.${i}.1` }));
  ok('cabeçalhos inválidos variando: o limite por usuário segura do mesmo jeito', r.filter((s) => s === 401).length <= 21 && r.slice(22).every((s) => s === 429), r);
  await stop(proc);
  ({ proc, base } = await start(code, 3405, { RENDER: '' }));
  r = await tentativas(base, 'adm', 45, (i) => ({ 'cf-connecting-ip': `203.0.113.${(i % 250) + 1}`, 'x-forwarded-for': `6.6.${i}.1`, 'true-client-ip': `10.1.${i}.1` }));
  ok('fora do Render (cabeçalhos ignorados): forjar não ajuda', r.filter((s) => s === 401).length <= 21 && r.slice(22).every((s) => s === 429), r);
  await stop(proc);
  ({ proc, base } = await start(code, 3406, { RENDER: 'true' }));
  r = await tentativas(base, 'adm', 45, {});
  ok('sem nenhum cabeçalho de IP: também limitado', r.filter((s) => s === 401).length <= 21 && r.slice(22).every((s) => s === 429), r);
  await stop(proc);

  /* ===== E. AUTORIZAÇÃO DE EXCEÇÃO: limite por quem pede, sem depender de IP ===== */
  ({ proc, base } = await start(code, 3407, { RENDER: 'true' }));
  const ck = await criaUsuarios(base);
  const aut = (i) => post(base, '/api/estoque/autorizar', { usuario: 'adm', senha: 'errada-123', justificativa: 'teste de limite' }, { cookie: ck, 'cf-connecting-ip': `203.0.113.${(i % 250) + 1}`, 'x-forwarded-for': `5.5.${i}.1` }).then((x) => x.status);
  const ra = []; for (let i = 0; i < 14; i++) ra.push(await aut(i));
  ok('exceção de estoque: IP forjado a cada tentativa não contorna (limite por pessoa)', ra.slice(0, 10).every((s) => s === 403) && ra.slice(10).every((s) => s === 429), ra);
  await stop(proc);

  /* ===== F. SESSÕES E SENHAS EXISTENTES ===== */
  const antigo = process.argv[2];
  if (antigo && fs.existsSync(antigo)) {
    const oldCode = copy(antigo), novo = copy(dir);
    let s = await start(oldCode, 3408, { RENDER: 'true' });
    const cookie = jar(await login(s.base, 'adm', 'senha12345'));
    await stop(s.proc);
    fs.rmSync(path.join(novo, 'data'), { recursive: true, force: true });
    fs.cpSync(path.join(oldCode, 'data'), path.join(novo, 'data'), { recursive: true });
    s = await start(novo, 3409, { RENDER: 'true' });
    ok('sessão criada pelo código anterior continua válida', (await fetch(s.base + '/api/me', { headers: { cookie } })).status === 200);
    ok('senha existente continua entrando (sem cookie de dispositivo)', (await login(s.base, 'adm', 'senha12345')).status === 200);
    ok('senha errada continua sendo recusada', (await login(s.base, 'adm', 'errada-123')).status === 401);
    await stop(s.proc);
  } else console.log('SKIP compatibilidade de sessão (passe a pasta do código anterior)');

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
