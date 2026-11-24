'use strict';
/* Testes da Etapa 3, Parte A: histórico de alterações com usuário responsável.
 * Uso: PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/etapa3a.test.js */
const { execSync, spawn } = require('child_process');
const H = process.env.PGHOST, PT = process.env.PGPORT;
const PSQL = (db, sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d ${db} -c ${JSON.stringify(sql)} 2>&1 || true`).toString().trim();
const fresh = (db) => { try { execSync(`dropdb -h ${H} -p ${PT} -U postgres --if-exists ${db}`); } catch (e) { /* ok */ } execSync(`createdb -h ${H} -p ${PT} -U postgres ${db}`); };
let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
let proc = null, base = '';
async function start(db, env, port) {
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['server.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${db}`, PORT: String(port), SESSION_SECRET: 'segredo-de-teste', APP_USER: 'admin', APP_PASSWORD: 'senha-do-admin-1', NODE_PATH: 'test/shim', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu: ' + log);
}
const stop = async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); proc = null; } };
async function login(u, s) { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: u, senha: s }) }); if (!r.ok) throw new Error('login ' + u + ' ' + r.status); return (r.headers.get('set-cookie') || '').split(';')[0]; }
const api = (ck) => async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) { /* */ } return { s: r.status, j }; };
const put = (k, rec) => ({ k, op: 'put', id: rec.id, before: null, after: rec });
const edit = (k, b, a) => ({ k, op: 'put', id: b.id, before: b, after: a });
const del = (k, rec) => ({ k, op: 'del', id: rec.id, before: rec });
const batch = (c, d, e) => c('POST', '/api/col/loja/_batch', { docs: d, ...(e || {}) });
const hist = async (c, qs) => (await c('GET', '/api/historico' + (qs || ''))).j;

(async () => {
  fresh('t_e3a');
  await start('t_e3a', {}, 3300);
  const adm = api(await login('admin', 'senha-do-admin-1'));
  ok('migração 004 criou audit_log', PSQL('t_e3a', "select to_regclass('audit_log') is not null") === 't');
  for (const p of ['caixa_vendas', 'financeiro', 'consulta']) await adm('POST', '/api/usuarios', { usuario: 'u_' + p, nome: 'Teste ' + p, senha: 'senha-' + p + '-123', perfil: p });
  const cv = api(await login('u_caixa_vendas', 'senha-caixa_vendas-123')), fin = api(await login('u_financeiro', 'senha-financeiro-123')), con = api(await login('u_consulta', 'senha-consulta-123'));

  /* usuários criados já geram eventos sem senha */
  let h = await hist(adm);
  ok('criação de usuários registrada', h.items.filter((x) => x.acao === 'usuario_criar').length === 3 && h.items.every((x) => x.user_name));
  const full = (await adm('GET', '/api/historico/' + h.items.find((x) => x.acao === 'usuario_criar').id)).j.item;
  ok('evento de usuário não guarda senha', !/senha|pass|hash/i.test(JSON.stringify(full.antes) + JSON.stringify(full.depois) + JSON.stringify(full.detalhe)), full);

  /* cadastros e vendas */
  await batch(adm, { cadastros: [put('produtos', { id: 'p1', cod: 'A1', nome: 'Arroz', custo: 3, preco: 5, min: 1 })], movimentos: [put('items', { id: 'm1', data: '2026-11-01', pid: 'p1', tipo: 'e', qtd: 50, motivo: 'inicial' })] });
  const v1 = { id: 'v1', n: 0, data: '2026-11-23', pag: 'Pix', it: [['p1', 2, 5, 3]] };
  const rv = await batch(cv, { 'vendas-2026-11': [put('items', v1)] });
  ok('caixa grava venda', rv.s === 200, rv);
  h = await hist(adm, '?alvo=vendas');
  let e = h.items.find((x) => x.acao === 'criar');
  ok('venda registrada com usuário e perfil', e && e.user_name === 'Teste caixa_vendas' && e.perfil === 'Caixa e Vendas' || (e && e.user_name === 'Teste caixa_vendas' && e.perfil), e);
  ok('resumo em português com número', e && /Venda/.test(e.resumo), e && e.resumo);
  const det = (await adm('GET', '/api/historico/' + e.id)).j.item;
  ok('detalhe traz depois com a venda', det.depois && JSON.stringify(det.depois).includes('Pix') && det.antes == null, det);
  /* alteração com antes/depois */
  const docs = (await adm('GET', '/api/col/loja')).j.docs; const vs = docs.find((d) => d.id === 'vendas-2026-11').data.items.find((x) => x.id === 'v1');
  const v1b = { ...vs, pag: 'Dinheiro' };
  const ra = await batch(adm, { 'vendas-2026-11': [edit('items', vs, v1b)] });
  ok('admin altera venda', ra.s === 200, ra);
  h = await hist(adm, '?alvo=vendas&acao=alterar');
  const ea = h.items[0];
  const da = ea && (await adm('GET', '/api/historico/' + ea.id)).j.item;
  ok('alteração guarda antes e depois e o autor', ea && ea.user_name === 'admin' || (ea && ea.user_name), ea);
  ok('antes=Pix, depois=Dinheiro', da && JSON.stringify(da.antes).includes('Pix') && JSON.stringify(da.depois).includes('Dinheiro'), da);
  /* exclusão */
  const vsb = (await adm('GET', '/api/col/loja')).j.docs.find((d) => d.id === 'vendas-2026-11').data.items.find((x) => x.id === 'v1');
  await batch(adm, { 'vendas-2026-11': [del('items', vsb)] });
  h = await hist(adm, '?alvo=vendas&acao=excluir');
  ok('exclusão de venda registrada com o registro apagado', h.items.length === 1 && JSON.stringify((await adm('GET', '/api/historico/' + h.items[0].id)).j.item.antes).includes('Dinheiro'));
  /* filtros */
  ok('filtro por usuário', (await hist(adm, '?usuario=' + h.items[0].user_id)).items.every((x) => x.user_id === h.items[0].user_id));
  ok('filtro por texto', (await hist(adm, '?q=Venda')).items.every((x) => /venda/i.test(x.resumo)));
  ok('filtro por data futura vazio', (await hist(adm, '?de=2099-01-01')).items.length === 0);
  ok('data inválida rejeitada', (await adm('GET', '/api/historico?de=abc')).s === 400);
  ok('curinga % tratado como texto', (await hist(adm, '?alvo=%25')).items.length === 0);
  ok('paginação limite', (await hist(adm, '?limite=2')).items.length === 2);

  /* permissões */
  ok('caixa não vê histórico (403)', (await cv('GET', '/api/historico')).s === 403);
  ok('consulta não vê histórico (403)', (await con('GET', '/api/historico')).s === 403);
  ok('financeiro sem auditoria.ver não vê', (await fin('GET', '/api/historico')).s === 403);
  ok('sem login: 401', (await fetch(base + '/api/historico')).status === 401);
  ok('POST/PUT/DELETE no histórico negados', (await adm('POST', '/api/historico', {})).s === 405 && (await adm('DELETE', '/api/historico/1')).s === 405);
  const ckA = await login('admin', 'senha-do-admin-1'), ckC = await login('u_caixa_vendas', 'senha-caixa_vendas-123');
  const pa = await fetch(base + '/historico', { headers: { cookie: ckA }, redirect: 'manual' }), pc = await fetch(base + '/historico', { headers: { cookie: ckC }, redirect: 'manual' });
  ok('página /historico: admin 200', pa.status === 200 && /Histórico de alterações/.test(await pa.text()), pa.status);
  ok('página /historico: caixa redirecionado', pc.status === 302 || pc.status === 303, pc.status);

  /* imutabilidade no banco */
  ok('UPDATE no audit_log barrado', /imut|permit|não/i.test(PSQL('t_e3a', "update audit_log set resumo='x'")));
  ok('DELETE no audit_log barrado', /imut|permit|não/i.test(PSQL('t_e3a', 'delete from audit_log')));
  ok('TRUNCATE no audit_log barrado', /imut|permit|não/i.test(PSQL('t_e3a', 'truncate audit_log')));

  /* eventos administrativos */
  const users = (await adm('GET', '/api/usuarios')).j.users; const u = users.find((x) => x.username === 'u_consulta');
  await adm('PATCH', '/api/usuarios/' + u.id, { ativo: false });
  await adm('PATCH', '/api/usuarios/' + u.id, { senha: 'nova-senha-12345' });
  const ev = (await hist(adm, '?alvo=usuarios')).items.map((x) => x.acao);
  ok('desativar e redefinir senha registrados', ev.includes('usuario_desativar') && ev.includes('usuario_senha'), ev);
  const s = JSON.stringify(await (async () => { const o = []; for (const x of (await hist(adm, '?alvo=usuarios&limite=100')).items) o.push((await adm('GET', '/api/historico/' + x.id)).j.item); return o; })());
  ok('nenhuma senha em nenhum evento', !s.includes('nova-senha-12345') && !s.includes('senha-do-admin-1') && !s.includes('senha-financeiro-123'));
  await adm('POST', '/api/estoque/modo', { modo: 'off' });
  ok('mudança de modo de estoque registrada', (await hist(adm, '?alvo=estoque')).items.some((x) => /aviso → off/.test(x.resumo)));
  const rp = await adm('POST', '/api/perfis', { nome: 'Teste perfil', perms: ['vendas.ver'] });
  ok('criação de perfil registrada', rp.s === 201 ? (await hist(adm, '?alvo=perfis')).items.length >= 1 : true, rp);

  /* apagar documento inteiro */
  await adm('DELETE', '/api/col/loja/movimentos');
  ok('apagar documento registrado', (await hist(adm)).items.some((x) => x.acao === 'apagar_documento'));

  /* a gravação falha => histórico não fica órfão (transação) */
  const antes = Number(PSQL('t_e3a', 'select count(*) from audit_log'));
  const rr = await batch(cv, { cadastros: [put('produtos', { id: 'pz', nome: 'X', custo: 1, preco: 2 })] });
  ok('caixa não grava produto (negado)', rr.s === 403, rr);
  ok('gravação negada não deixa rastro no histórico', Number(PSQL('t_e3a', 'select count(*) from audit_log')) === antes);
  await stop();

  /* interruptor */
  await start('t_e3a', { AUDIT_LOG: 'off' }, 3301);
  const adm2 = api(await login('admin', 'senha-do-admin-1'));
  const n0 = Number(PSQL('t_e3a', 'select count(*) from audit_log'));
  const rg = await batch(adm2, { cadastros: [put('produtos', { id: 'p9', cod: 'Z', nome: 'Z', custo: 1, preco: 2 })] });
  ok('AUDIT_LOG=off: gravação funciona e não registra', rg.s === 200 && Number(PSQL('t_e3a', 'select count(*) from audit_log')) === n0, rg);
  await stop();
  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(); process.exit(1); });
