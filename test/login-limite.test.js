'use strict';
/* Limite de tentativas de login: IP do cliente atrás do Render, cabeçalhos forjados e acessos legítimos.
 * Roda em ambiente local isolado (armazenamento em arquivo, sem banco e sem produção).
 * Uso: node test/login-limite.test.js [pasta-do-codigo-antigo-para-compatibilidade-de-sessao] */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const SECRET = 'segredo-de-teste';

async function start(dir, port, env) {
  const proc = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), APP_USER: 'adm', APP_PASSWORD: 'senha12345', SESSION_SECRET: SECRET, DATABASE_URL: '', ...env }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) return { proc, base }; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu');
}
const login = (base, h, senha) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ usuario: 'adm', senha: senha || 'errada-123' }) });
const falhas = async (base, n, h) => { const r = []; for (let i = 0; i < n; i++) r.push((await login(base, typeof h === 'function' ? h(i) : h)).status); return r; };

(async () => {
  const dir = path.join(__dirname, '..');
  const cwdCopy = (src) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'code-')); fs.cpSync(src, t, { recursive: true, filter: (f) => !/node_modules|\.git(\/|$)|\/data(\/|$)/.test(f) }); return t; };
  const code = cwdCopy(dir);

  /* ---------- atrás do Render (RENDER=true) ---------- */
  let { proc, base } = await start(code, 3301, { RENDER: 'true' });
  const A = { 'cf-connecting-ip': '203.0.113.10' }, B = { 'cf-connecting-ip': '203.0.113.20' };

  let r = await falhas(base, 9, A);
  ok('tentativas normais (9 erros) continuam dando 401', r.every((s) => s === 401), r);
  ok('login correto ainda funciona depois de 9 erros', (await login(base, A, 'senha12345')).status === 200);
  r = await falhas(base, 10, A);
  ok('10 erros seguidos do mesmo IP: o 11º é bloqueado (429)', r.slice(0, 10).every((s) => s === 401) && (await login(base, A)).status === 429, r);
  ok('IP bloqueado não entra nem com a senha certa', (await login(base, A, 'senha12345')).status === 429);
  ok('outro IP legítimo não é afetado pelo bloqueio', (await login(base, B, 'senha12345')).status === 200);

  // forjar X-Forwarded-For não contorna o limite
  const C = { 'cf-connecting-ip': '203.0.113.30' };
  r = await falhas(base, 12, (i) => ({ ...C, 'x-forwarded-for': `9.9.9.${i}, 198.51.100.7` }));
  ok('X-Forwarded-For forjado e variando NÃO contorna o limite', r.slice(10).every((s) => s === 429) && r.slice(0, 10).every((s) => s === 401), r);
  // forjar X-Forwarded-For não faz um cliente legítimo ser bloqueado por outro
  ok('X-Forwarded-For forjado não faz o IP de outra pessoa ser bloqueado', (await login(base, { 'cf-connecting-ip': '203.0.113.40', 'x-forwarded-for': '203.0.113.30' }, 'senha12345')).status === 200);
  // sem cabeçalho de IP (acesso direto ao serviço): vale o endereço da conexão, e forjar XFF não ajuda
  r = await falhas(base, 12, (i) => ({ 'x-forwarded-for': `7.7.7.${i}` }));
  ok('sem CF-Connecting-IP: usa o endereço da conexão e XFF variando não contorna', r.slice(10).every((s) => s === 429), r);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  // valor inválido no cabeçalho cai para o endereço da conexão
  ({ proc, base } = await start(code, 3302, { RENDER: 'true' }));
  r = await falhas(base, 12, (i) => ({ 'cf-connecting-ip': 'lixo-' + i }));
  ok('CF-Connecting-IP inválido é ignorado (usa a conexão): limite vale', r.slice(10).every((s) => s === 429), r);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  // true-client-ip como alternativa
  ({ proc, base } = await start(code, 3303, { RENDER: 'true' }));
  r = await falhas(base, 12, (i) => ({ 'true-client-ip': '203.0.113.50', 'x-forwarded-for': '1.2.3.' + i }));
  ok('True-Client-IP também vale como origem e XFF é ignorado', r.slice(10).every((s) => s === 429), r);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });


  /* ---------- casos de borda do cabeçalho (revisão final) ---------- */
  ({ proc, base } = await start(code, 3308, { RENDER: 'true' }));
  // valores que NÃO são um único IP válido são ignorados: o cliente cai no endereço da conexão e o limite vale
  const invalidos = ['1.1.1.1, 2.2.2.2', '1.1.1.1:8080', '999.1.1.1', 'a'.repeat(5000), ' ', '1.1.1.1;x'];
  r = await falhas(base, 12, (i) => ({ 'cf-connecting-ip': invalidos[i % invalidos.length] }));
  ok('lista de IPs, IP com porta, IP inválido, valor enorme ou vazio no CF-Connecting-IP são ignorados e o limite vale', r.slice(10).every((x) => x === 429), r);
  // sem nenhum cabeçalho de IP, todos compartilham o endereço da conexão (atrás do balanceador seria o mesmo para todos)
  ok('SEM cabeçalho de IP, outra pessoa sem cabeçalho também fica bloqueada (limitação conhecida: contador compartilhado)', (await login(base, {}, 'senha12345')).status === 429);
  ok('...mas quem chega COM CF-Connecting-IP válido não sofre esse bloqueio compartilhado', (await login(base, { 'cf-connecting-ip': '203.0.113.90' }, 'senha12345')).status === 200);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  ({ proc, base } = await start(code, 3309, { RENDER: 'true' }));
  // IPv6 e maiúsculas/minúsculas contam como o mesmo endereço; espaços ao redor são aparados
  r = await falhas(base, 12, (i) => ({ 'cf-connecting-ip': i % 2 ? ' 2001:DB8::1 ' : '2001:db8::1' }));
  ok('IPv6 (maiúsculas/minúsculas, espaços) é normalizado e conta como um só cliente', r.slice(10).every((x) => x === 429) && r.slice(0, 10).every((x) => x === 401), r);
  // se os dois cabeçalhos existem e divergem, vale o CF-Connecting-IP (o True-Client-IP não permite fugir do limite)
  r = await falhas(base, 12, (i) => ({ 'cf-connecting-ip': '203.0.113.100', 'true-client-ip': '10.0.0.' + i }));
  ok('com os dois cabeçalhos, vale o CF-Connecting-IP; variar o True-Client-IP não contorna', r.slice(10).every((x) => x === 429), r);
  // o bloqueio dura enquanto a janela de 15 minutos estiver aberta e é por IP: uma pessoa não bloqueia outra
  ok('bloqueio de um IP não afeta quem usa outro IP, mesmo com o mesmo usuário', (await login(base, { 'cf-connecting-ip': '203.0.113.101' }, 'senha12345')).status === 200);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  /* ---------- fora do Render (teste local / acesso direto): cabeçalhos não são confiáveis ---------- */
  ({ proc, base } = await start(code, 3304, { RENDER: '' }));
  r = await falhas(base, 12, (i) => ({ 'cf-connecting-ip': `203.0.113.${i + 1}`, 'x-forwarded-for': `8.8.8.${i}` }));
  ok('fora do Render: CF-Connecting-IP e XFF forjados são ignorados e o limite vale', r.slice(10).every((s) => s === 429) && r.slice(0, 10).every((s) => s === 401), r);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  /* ---------- exceção de estoque usa o mesmo limite ---------- */
  ({ proc, base } = await start(code, 3305, { RENDER: 'true' }));
  const ck = ((await login(base, { 'cf-connecting-ip': '203.0.113.60' }, 'senha12345')).headers.get('set-cookie') || '').split(';')[0];
  const aut = (h) => fetch(base + '/api/estoque/autorizar', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck, ...h }, body: JSON.stringify({ usuario: 'adm', senha: 'errada-123', justificativa: 'teste de limite' }) }).then((x) => x.status);
  const ra = []; for (let i = 0; i < 12; i++) ra.push(await aut({ 'cf-connecting-ip': '203.0.113.70', 'x-forwarded-for': '5.5.5.' + i }));
  ok('autorização de exceção: XFF forjado não contorna o limite', ra.slice(0, 10).every((s) => s === 403) && ra.slice(10).every((s) => s === 429), ra);
  await new Promise((rs) => { proc.kill(); setTimeout(rs, 300); });

  /* ---------- sessões e senhas existentes ---------- */
  // cookie gerado pelo código ANTES da correção continua valendo no código novo (mesmo segredo)
  const antigo = process.argv[2];
  if (antigo && fs.existsSync(antigo)) {
    const oldCode = cwdCopy(antigo), novo = cwdCopy(dir);
    let s = await start(oldCode, 3306, { RENDER: 'true' });
    const cookie = ((await login(s.base, {}, 'senha12345')).headers.get('set-cookie') || '').split(';')[0];
    await new Promise((rs) => { s.proc.kill(); setTimeout(rs, 300); });
    fs.rmSync(path.join(novo, 'data'), { recursive: true, force: true });
    fs.cpSync(path.join(oldCode, 'data'), path.join(novo, 'data'), { recursive: true }); // mesmos usuários e senhas
    s = await start(novo, 3307, { RENDER: 'true' });
    const me = await fetch(s.base + '/api/me', { headers: { cookie } });
    ok('sessão criada pelo código anterior continua válida no código novo', me.status === 200, me.status);
    ok('senha existente continua entrando no código novo', (await login(s.base, {}, 'senha12345')).status === 200);
    s.proc.kill();
  } else console.log('SKIP compatibilidade de sessão (passe a pasta do código anterior como argumento)');

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
