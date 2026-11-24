'use strict';
/* Rollback da Etapa 2: o código da Etapa 1 (commit 29aaaf1) precisa funcionar no banco já migrado pela 002.
 * Uso: depois de rodar etapa2.test.js (que deixa o banco t_e2 migrado e com usuários), com o código antigo em /tmp/old:
 *   PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/rollback.test.js */
const { execSync, spawn } = require('child_process');
const PT = process.env.PGPORT, H = process.env.PGHOST;
const PSQL = (sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d t_e2 -c ${JSON.stringify(sql)}`).toString().trim();
let ok = 0, bad = 0; const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : ' -> ' + JSON.stringify(x).slice(0, 200))); };
(async () => {
  const hash = PSQL("select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs");
  const proc = spawn('node', ['server.js'], { cwd: '/tmp/old', env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/t_e2`, PORT: '3301', SESSION_SECRET: 'segredo-de-teste', NODE_PATH: process.cwd() + '/test/shim' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:3301';
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  const login = async (u, p) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: u, senha: p }) }); return { s: r.status, ck: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  const get = async (ck, u) => { const r = await fetch(base + u, { headers: { cookie: ck } }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const a = await login('admin', 'senha-do-admin-1');
  t('código antigo sobe no banco migrado e o administrador entra', a.s === 200, a);
  const me = await get(a.ck, '/api/me');
  t('administrador continua administrador (papel antigo)', me.j.user.role === 'admin' && me.j.user.users === true, me.j);
  const docs = await get(a.ck, '/api/col/loja');
  t('lê os mesmos documentos', docs.s === 200 && docs.j.docs.length >= 5, docs.s);
  const e = await login('u_estoque', 'senha-estoque-123');
  const em = await get(e.ck, '/api/me');
  t('perfil novo cai no papel mais restrito (caixa) na versão antiga', em.j.user.role === 'caixa' && em.j.user.tabs.join() === 'caixa,vendas,clientes', em.j.user);
  const w = await fetch(base + '/api/col/loja/_batch', { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.ck }, body: JSON.stringify({ docs: { movimentos: [{ k: 'items', op: 'put', id: 'rbk', before: null, after: { id: 'rbk', data: '2026-11-23', pid: 'p1', tipo: 'e', qtd: 1, motivo: 'teste de rollback' } }] } }) });
  t('a versão antiga ainda grava', w.status === 200, w.status);
  proc.kill('SIGTERM');
  t('as tabelas novas continuam no banco (nada foi removido)', PSQL("select count(*) from information_schema.tables where table_name in ('app_roles','app_settings','app_stock_log')") === '3');
  console.log(`\n${ok} passaram, ${bad} falharam`); process.exit(bad ? 1 : 0);
})();
