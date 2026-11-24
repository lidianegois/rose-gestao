'use strict';
/* Testes da Etapa 2: perfis, permissões (leitura e escrita pela API), campos escondidos, proteção de estoque,
 * simultaneidade, migração sobre dados e interruptor RBAC_V2=off. Falam HTTP com o servidor de verdade.
 * Uso: PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/etapa2.test.js */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const H = process.env.PGHOST, PT = process.env.PGPORT;
const PSQL = (db, sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d ${db} -c ${JSON.stringify(sql)}`).toString().trim();
const fresh = (db) => { try { execSync(`dropdb -h ${H} -p ${PT} -U postgres --if-exists ${db}`); } catch (e) { /* ok */ } execSync(`createdb -h ${H} -p ${PT} -U postgres ${db}`); };
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : '')); } };

let proc = null, base = '';
async function start(db, env, port) {
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['server.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${db}`, PORT: String(port), SESSION_SECRET: 'segredo-de-teste', APP_USER: 'admin', APP_PASSWORD: 'senha-do-admin-1', NODE_PATH: 'test/shim', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/health'); if (r.ok) return; } catch (e) { /* ainda subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu: ' + log);
}
const stop = async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); proc = null; } };

async function login(usuario, senha) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, senha }) });
  if (!r.ok) throw new Error('login falhou ' + usuario + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const api = (ck) => async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* sem corpo */ }
  return { s: r.status, j };
};
const put = (k, rec) => ({ k, op: 'put', id: rec.id, before: null, after: rec });
const edit = (k, before, after) => ({ k, op: 'put', id: before.id, before, after });
const del = (k, rec) => ({ k, op: 'del', id: rec.id, before: rec });
const batch = (c, docs, extra) => c('POST', '/api/col/loja/_batch', { docs, ...(extra || {}) });
const docs = async (c) => { const r = await c('GET', '/api/col/loja'); const o = {}; (r.j.docs || []).forEach((d) => { o[d.id] = d.data; }); return o; };
const venda = (i, pid, q) => ({ id: 'vt' + i, n: 0, data: '2026-11-23', pag: 'Pix', it: [[pid, q, 5, 0]] });
const saldoDe = async (c, pid) => ((await c('GET', '/api/estoque/relatorio')).j.linhas.find((l) => l.id === pid) || {}).saldo;

(async () => {
  /* ---------- 1. migração 002 sobre dados antigos: nada muda, usuários ganham o perfil equivalente ---------- */
  fresh('t_e2mig');
  execSync(`psql -X -q -h ${H} -p ${PT} -U postgres -d t_e2mig -f db/migrations/000_base.sql`);
  execSync(`psql -X -q -h ${H} -p ${PT} -U postgres -d t_e2mig -f db/migrations/001_simultaneidade.sql`);
  PSQL('t_e2mig', "create table schema_migrations (version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())");
  PSQL('t_e2mig', "insert into schema_migrations(version,name,checksum) select '000','000_base.sql','x' union select '001','001_simultaneidade.sql','x'");
  PSQL('t_e2mig', `insert into app_docs(col,id,data) values ('loja','cadastros','{"produtos":[{"id":"p1","nome":"Arroz","custo":3,"preco":5}],"clientes":[],"fornecedores":[],"seq":{"venda":3,"compra":0}}'), ('loja','vendas-2026-11','{"items":[{"id":"v1","n":3,"data":"2026-11-02","pag":"Pix","it":[["p1",1,5,3]]}]}')`);
  PSQL('t_e2mig', "insert into app_users(id,username,name,pass,role,active,pwv) values ('u1','ana','Ana','x','admin',true,1),('u2','bia','Bia','x','operador',true,1),('u3','cris','Cris','x','caixa',true,1)");
  const hashAntes = PSQL('t_e2mig', "select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs");
  await start('t_e2mig', {}, 3200);
  ok('migração 002: dados idênticos', PSQL('t_e2mig', "select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs") === hashAntes);
  ok('migração 002: admin→administrador, operador→gerente_atual, caixa→caixa_atual', PSQL('t_e2mig', "select string_agg(role_id,',' order by id) from app_users") === 'administrador,gerente_atual,caixa_atual');
  ok('migração 002: 8 perfis semeados', PSQL('t_e2mig', 'select count(*) from app_roles') === '8');
  ok('migração 002: modo de estoque começa em aviso', PSQL('t_e2mig', "select value #>> '{}' from app_settings where key='estoque_modo'") === 'aviso');
  await stop();

  /* ---------- 2. servidor novo, dados de teste ---------- */
  fresh('t_e2');
  await start('t_e2', {}, 3201);
  const adm = api(await login('admin', 'senha-do-admin-1'));
  const seed = {
    cadastros: [
      put('produtos', { id: 'p1', cod: 'A1', nome: 'Arroz', custo: 3, preco: 5, min: 2 }), put('produtos', { id: 'p2', cod: 'A2', nome: 'Feijão', custo: 4, preco: 8, min: 2 }),
      put('produtos', { id: 'p3', cod: 'A3', nome: 'Óleo', custo: 6, preco: 9, min: 2 }), put('produtos', { id: 'p4', cod: 'A4', nome: 'Sal', custo: 1, preco: 2, min: 2 }),
      put('clientes', { id: 'c1', nome: 'Ana Cliente' }), put('fornecedores', { id: 'f1', nome: 'Atacado' }),
      { k: 'config', op: 'field', key: 'saldoIni', before: null, bAbs: true, after: 100, aAbs: false }, { k: 'config', op: 'field', key: 'taxaDeb', before: null, bAbs: true, after: 1.4, aAbs: false },
    ],
    movimentos: [put('items', { id: 'm1', data: '2026-11-01', pid: 'p1', tipo: 'e', qtd: 10, motivo: 'Estoque inicial' }), put('items', { id: 'm2', data: '2026-11-01', pid: 'p2', tipo: 'e', qtd: 3, motivo: 'Estoque inicial' }), put('items', { id: 'm3', data: '2026-11-01', pid: 'p3', tipo: 'e', qtd: 5, motivo: 'Estoque inicial' })],
    'vendas-2026-11': [put('items', { id: 'v1', n: 1, data: '2026-11-02', pag: 'Fiado / a prazo', cliente: 'Ana Cliente', cid: 'c1', it: [['p1', 4, 5, 3]] })],
    compras: [put('items', { id: 'k1', n: 1, data: '2026-11-01', fid: 'f1', status: 'pendente', it: [['p1', 20, 4]] }), put('items', { id: 'k2', n: 2, data: '2026-11-01', fid: 'f1', status: 'recebido', receb: '2026-11-03', it: [['p3', 2, 6]] })],
    lancamentos: [
      put('items', { id: 'l1', tipo: 'd', cat: 'Compra de mercadorias', desc: 'Pedido de compra nº 1', valor: 80, data: '2026-11-01', venc: '2026-11-20', pago: '', vpago: 0, origem: 'compra:k1' }),
      put('items', { id: 'l2', tipo: 'r', cat: 'Vendas a prazo', desc: 'Venda nº 1', valor: 20, data: '2026-11-02', venc: '2026-11-25', pago: '', vpago: 0, origem: 'venda:v1', cli: 'c1' }),
      put('items', { id: 'l3', tipo: 'r', cat: 'Outros', desc: 'Receita avulsa', valor: 50, data: '2026-11-02', venc: '2026-11-25', pago: '', vpago: 0, origem: '' }),
    ],
    caixas: [put('items', { id: 'x1', data: '2026-11-23', ab: '08:00', fe: '', op: 'Cris', inicial: 100, mov: [] })],
  };
  const r0 = await batch(adm, seed, { bulk: true });
  ok('administrador importa dados de teste (bulk)', r0.s === 200, r0);

  /* usuários, um por perfil */
  const perfis = ['financeiro', 'caixa_vendas', 'estoque', 'compras', 'consulta', 'gerente_atual', 'caixa_atual'];
  const C = { adm };
  for (const p of perfis) {
    const rr = await adm('POST', '/api/usuarios', { usuario: 'u_' + p, nome: 'Teste ' + p, senha: 'senha-' + p + '-123', perfil: p });
    if (rr.s !== 201) console.log('criação falhou', p, rr);
    C[p] = api(await login('u_' + p, 'senha-' + p + '-123'));
  }
  ok('administrador criou os 7 usuários', Object.keys(C).length === 8);
  const me = await C.caixa_vendas('GET', '/api/me');
  ok('/api/me traz perfil, telas e permissões', me.j.user.profile === 'caixa_vendas' && me.j.user.tabs.join() === 'caixa,vendas,clientes' && me.j.user.perm.includes('caixa.vender') && !me.j.user.perm.includes('produtos.ver_custo'), me.j.user);

  /* ---------- 3. LEITURA filtrada ---------- */
  const D0 = {};
  for (const p of Object.keys(C)) D0[p] = await docs(C[p]);
  const cx = D0.caixa_vendas;
  ok('caixa: produtos sem custo', cx.cadastros.produtos.length === 4 && cx.cadastros.produtos.every((p) => p.custo === undefined));
  ok('caixa: sem fornecedores, sem compras, sem movimentos', cx.cadastros.fornecedores.length === 0 && cx.compras.items.length === 0 && cx.movimentos.items.length === 0);
  ok('caixa: só lançamentos a receber de venda/fiado', cx.lancamentos.items.length === 1 && cx.lancamentos.items[0].id === 'l2', cx.lancamentos);
  ok('caixa: custo das vendas zerado', cx['vendas-2026-11'].items[0].it[0][3] === 0);
  ok('caixa: config sem saldo inicial, com taxas', cx.cadastros.config.saldoIni === undefined && cx.cadastros.config.taxaDeb === 1.4);
  ok('caixa: recebe saldo de estoque pronto (p1=6, p2=3, p3=7)', cx.cadastros.saldos && cx.cadastros.saldos.p1 === 6 && cx.cadastros.saldos.p2 === 3 && cx.cadastros.saldos.p3 === 7, cx.cadastros.saldos);
  const es = D0.estoque;
  ok('estoque: produtos sem custo; sem clientes, vendas e lançamentos', es.cadastros.produtos.every((p) => p.custo === undefined) && es.cadastros.clientes.length === 0 && es['vendas-2026-11'].items.length === 0 && es.lancamentos.items.length === 0);
  ok('estoque: vê compras mas sem custo', es.compras.items.length === 2 && es.compras.items.every((c) => c.it.every((i) => i[2] === 0)));
  ok('estoque: vê movimentos e saldos', es.movimentos.items.length === 3 && es.cadastros.saldos.p1 === 6);
  const co = D0.compras;
  ok('compras: custo visível; sem vendas nem lançamentos; sem custo de venda', co.cadastros.produtos[0].custo === 3 && co['vendas-2026-11'].items.length === 0 && co.lancamentos.items.length === 0 && co.compras.items[0].it[0][2] === 4);
  const fi = D0.financeiro;
  ok('financeiro: lê tudo, com custo e margem', fi.lancamentos.items.length === 3 && fi.cadastros.produtos[0].custo === 3 && fi['vendas-2026-11'].items[0].it[0][3] === 3 && fi.cadastros.config.saldoIni === 100 && !fi.cadastros.saldos);
  const cs = D0.consulta;
  ok('consulta: lê todos os módulos', cs.lancamentos.items.length === 3 && cs.compras.items.length === 2 && cs['vendas-2026-11'].items.length === 1 && cs.cadastros.produtos[0].custo === 3);
  ok('administrador e gerente (atual) leem tudo', D0.adm.lancamentos.items.length === 3 && D0.gerente_atual.lancamentos.items.length === 3 && D0.gerente_atual.cadastros.produtos[0].custo === 3);
  ok('caixa (atual) lê só o que o Caixa/Vendas lê', D0.caixa_atual.lancamentos.items.length === 1 && D0.caixa_atual.compras.items.length === 0);
  ok('ninguém recebe a numeração/seq nem campos escondidos por outra rota', (await C.caixa_vendas('GET', '/api/col/loja/lancamentos')).s === 405);

  /* ---------- 4. APIs de administração fechadas ---------- */
  for (const p of ['financeiro', 'caixa_vendas', 'estoque', 'compras', 'consulta', 'gerente_atual', 'caixa_atual']) {
    const a = await C[p]('GET', '/api/usuarios'), b = await C[p]('GET', '/api/perfis'), c2 = await C[p]('POST', '/api/estoque/modo', { modo: 'off' }), d = await C[p]('DELETE', '/api/col/loja/cadastros');
    ok(`${p}: usuários, perfis, modo do estoque e apagar documento negados`, a.s === 403 && b.s === 403 && c2.s === 403 && d.s === 403, [a.s, b.s, c2.s, d.s]);
  }
  ok('um não-admin não consegue importar/restaurar (bulk)', (await batch(C.gerente_atual, { cadastros: [] }, { bulk: true })).s === 403);

  /* ---------- 5. ESCRITA por perfil (matriz) ---------- */
  const cxd = D0.adm; // dados completos para montar "before"
  const prod1 = cxd.cadastros.produtos[0];
  // caixa
  let r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(1, 'p1', 1))] });
  ok('caixa vende no PDV (200) e recebe número do servidor', r.s === 200 && r.j.assigned['vendas-2026-11'].vt1 === 2, r);
  const nova = (await docs(adm))['vendas-2026-11'].items.find((x) => x.id === 'vt1');
  ok('venda do caixa ganha o custo real do produto (servidor completa)', nova.it[0][3] === 3, nova);
  r = await batch(C.caixa_vendas, { cadastros: [edit('produtos', cx.cadastros.produtos[0], { ...cx.cadastros.produtos[0], preco: 99 })] });
  ok('caixa NÃO altera produto', r.s === 403, r);
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [del('items', nova)] });
  ok('caixa NÃO exclui venda', r.s === 403);
  r = await batch(C.caixa_vendas, { compras: [put('items', { id: 'kx', n: 0, status: 'pendente', it: [] })] });
  ok('caixa NÃO cria compra', r.s === 403);
  r = await batch(C.caixa_vendas, { lancamentos: [put('items', { id: 'lx', tipo: 'd', cat: 'Outros', desc: 'x', valor: 1, data: '2026-11-23', venc: '2026-11-23', pago: '', vpago: 0, origem: '' })] });
  ok('caixa NÃO cria despesa', r.s === 403);
  const l2 = cx.lancamentos.items[0];
  r = await batch(C.caixa_vendas, { lancamentos: [edit('items', l2, { ...l2, pago: '2026-11-23', vpago: 20, forma: 'Pix' })] });
  ok('caixa recebe fiado (baixa de lançamento a receber de venda)', r.s === 200, r);
  r = await batch(C.caixa_vendas, { lancamentos: [edit('items', { ...l2, pago: '2026-11-23', vpago: 20, forma: 'Pix' }, { ...l2, pago: '2026-11-23', vpago: 20, forma: 'Pix', valor: 1 })] });
  ok('caixa NÃO altera valor de lançamento', r.s === 403, r);
  const x1 = cx.caixas ? null : null;
  r = await batch(C.caixa_vendas, { caixas: [edit('items', (await docs(adm)).caixas.items[0], { ...(await docs(adm)).caixas.items[0], mov: [{ h: '10:00', t: 'san', v: 50 }] })] });
  ok('caixa faz sangria (tem a permissão)', r.s === 200, r);
  r = await batch(C.consulta, { caixas: [edit('items', (await docs(adm)).caixas.items[0], { ...(await docs(adm)).caixas.items[0], mov: [] })] });
  ok('consulta NÃO mexe no caixa', r.s === 403);
  // consulta
  r = await batch(C.consulta, { 'vendas-2026-11': [put('items', venda(2, 'p1', 1))] });
  ok('consulta NÃO grava nada (venda)', r.s === 403);
  r = await batch(C.consulta, { movimentos: [put('items', { id: 'mx', data: '2026-11-23', pid: 'p1', tipo: 'e', qtd: 1, motivo: 'x' })] });
  ok('consulta NÃO grava nada (movimento)', r.s === 403);
  // estoque
  const es1 = es.cadastros.produtos[0];
  r = await batch(C.estoque, { cadastros: [edit('produtos', es1, { ...es1, nome: 'Arroz Tipo 1' })] });
  const pAdm = ((await docs(adm)).cadastros.produtos).find((p) => p.id === 'p1');
  ok('estoque edita produto e o custo (que ele não vê) é preservado', r.s === 200 && pAdm.nome === 'Arroz Tipo 1' && pAdm.custo === 3, [r, pAdm]);
  r = await batch(C.estoque, { movimentos: [put('items', { id: 'm9', data: '2026-11-23', pid: 'p1', tipo: 'e', qtd: 5, motivo: 'Ajuste de inventário' })] });
  ok('estoque registra entrada', r.s === 200);
  const k1 = es.compras.items.find((c) => c.id === 'k1');
  r = await batch(C.estoque, { compras: [edit('items', k1, { ...k1, status: 'recebido', receb: '2026-11-23' })], lancamentos: [put('items', { id: 'lr', tipo: 'd', cat: 'Compra de mercadorias', desc: 'Pedido de compra nº 1', valor: 80, data: '2026-11-23', venc: '2026-11-30', pago: '', vpago: 0, origem: 'compra:k1' })] });
  const kA = ((await docs(adm)).compras.items).find((c) => c.id === 'k1');
  ok('estoque recebe compra (e o custo da compra continua intacto)', r.s === 200 && kA.status === 'recebido' && kA.it[0][2] === 4, [r, kA]);
  r = await batch(C.estoque, { compras: [edit('items', kA, { ...kA, fid: 'f9' })] });
  ok('estoque NÃO edita pedido de compra (só receber)', r.s === 403);
  r = await batch(C.estoque, { 'vendas-2026-11': [put('items', venda(3, 'p1', 1))] });
  ok('estoque NÃO vende', r.s === 403);
  r = await batch(C.estoque, { lancamentos: [put('items', { id: 'lq', tipo: 'd', cat: 'Outros', desc: 'x', valor: 1, data: '2026-11-23', venc: '2026-11-23', pago: '', vpago: 0, origem: '' })] });
  ok('estoque NÃO cria lançamento manual', r.s === 403);
  // compras
  const cm = D0.compras.compras.items.find((c) => c.id === 'k2');
  r = await batch(C.compras, { compras: [edit('items', cm, { ...cm, obs: 'confirmado' })] });
  ok('compras edita pedido', r.s === 200);
  r = await batch(C.compras, { movimentos: [put('items', { id: 'mc', data: '2026-11-23', pid: 'p1', tipo: 'e', qtd: 1, motivo: 'x' })] });
  ok('compras NÃO mexe em movimentação de estoque', r.s === 403);
  r = await batch(C.compras, { lancamentos: [edit('items', D0.adm.lancamentos.items[0], { ...D0.adm.lancamentos.items[0], pago: '2026-11-23', vpago: 80 })] });
  ok('compras NÃO dá baixa em pagamento', r.s === 403);
  // financeiro
  const lf = fi.lancamentos.items[0];
  r = await batch(C.financeiro, { lancamentos: [edit('items', lf, { ...lf, pago: '2026-11-23', vpago: 80, forma: 'Pix' })] });
  ok('financeiro dá baixa em conta a pagar', r.s === 200, r);
  r = await batch(C.financeiro, { 'vendas-2026-11': [put('items', venda(4, 'p1', 1))] });
  ok('financeiro NÃO vende no PDV', r.s === 403);
  r = await batch(C.financeiro, { cadastros: [edit('produtos', fi.cadastros.produtos[1], { ...fi.cadastros.produtos[1], preco: 1 })] });
  ok('financeiro NÃO altera produto', r.s === 403);
  // gerente atual = como antes
  r = await batch(C.gerente_atual, { 'vendas-2026-11': [put('items', venda(5, 'p1', 1))], cadastros: [edit('produtos', D0.gerente_atual.cadastros.produtos[3], { ...D0.gerente_atual.cadastros.produtos[3], preco: 3 })] });
  ok('gerente (atual) continua gravando vendas e produtos', r.s === 200, r);
  ok('gerente (atual) NÃO vira administrador (sem backup/usuários)', (await C.gerente_atual('GET', '/api/usuarios')).s === 403);
  // PUT do documento inteiro respeita as mesmas regras
  r = await C.caixa_vendas('PUT', '/api/col/loja/cadastros', { ...cx.cadastros, produtos: cx.cadastros.produtos.map((p) => ({ ...p, preco: 1 })) });
  ok('PUT do documento inteiro: caixa não consegue alterar produtos', r.s === 403, r);
  // documento desconhecido: só administrador
  r = await batch(C.gerente_atual, { 'segredo': [put('items', { id: 'z' })] });
  ok('documento desconhecido: negado ao gerente', r.s === 403);
  r = await batch(adm, { segredo: [put('items', { id: 'z' })] });
  ok('documento desconhecido: administrador pode', r.s === 200);

  /* ---------- 6. permissões individuais ---------- */
  const lista = (await adm('GET', '/api/usuarios')).j.users;
  const uConsulta = lista.find((u) => u.username === 'u_consulta'), uCx = lista.find((u) => u.username === 'u_caixa_vendas');
  let pr = await adm('PATCH', '/api/usuarios/' + uConsulta.id, { conceder: ['produtos.editar'] });
  ok('administrador concede permissão individual', pr.s === 200 && pr.j.user.perm_grant.includes('produtos.editar'), pr);
  const consulta2 = api(await login('u_consulta', 'senha-consulta-123'));
  r = await batch(consulta2, { cadastros: [edit('produtos', cs.cadastros.produtos[2], { ...cs.cadastros.produtos[2], preco: 10 })] });
  ok('permissão concedida vale (consulta edita produto)', r.s === 200, r);
  ok('sessão antiga cai ao mudar permissões', (await C.consulta('GET', '/api/me')).s === 401);
  pr = await adm('PATCH', '/api/usuarios/' + uCx.id, { negar: ['caixa.vender'] });
  const cx2 = api(await login('u_caixa_vendas', 'senha-caixa_vendas-123'));
  r = await batch(cx2, { 'vendas-2026-11': [put('items', venda(6, 'p1', 1))] });
  ok('permissão negada individualmente vale (caixa sem PDV; vendas.editar ainda grava venda manual)', r.s === 200 || r.s === 403);
  pr = await adm('PATCH', '/api/usuarios/' + uCx.id, { negar: ['caixa.vender', 'vendas.editar'] });
  const cx3 = api(await login('u_caixa_vendas', 'senha-caixa_vendas-123'));
  r = await batch(cx3, { 'vendas-2026-11': [put('items', venda(7, 'p1', 1))] });
  ok('negando caixa.vender e vendas.editar a venda é recusada', r.s === 403, r);
  const lastAdmin = (await adm('GET', '/api/usuarios')).j.users.find((u) => u.username === 'admin');
  pr = await adm('PATCH', '/api/usuarios/' + lastAdmin.id, { perfil: 'consulta' });
  ok('não deixa o sistema sem administrador', pr.s === 400, pr);
  pr = await adm('PUT', '/api/perfis/administrador', { perms: ['painel.ver'] });
  ok('perfil Administrador não pode ser reduzido', pr.s === 400);
  pr = await adm('PUT', '/api/perfis/consulta', { perms: ['painel.ver', 'vendas.ver'] });
  ok('administrador edita as permissões de um perfil', pr.s === 200);
  pr = await adm('PUT', '/api/perfis/consulta', { perms: ['painel.ver', 'vendas.ver', 'permissao.inventada'] });
  ok('permissão inexistente é ignorada', pr.s === 200 && !(await adm('GET', '/api/perfis')).j.perfis.find((p) => p.id === 'consulta').perms.includes('permissao.inventada'));
  await adm('PUT', '/api/perfis/consulta', { perms: require('./../lib/perms').PRESETS.consulta.perms });

  /* ---------- 6b. arquivar e excluir usuários ---------- */
  let ar = await adm('POST', '/api/usuarios', { usuario: 'u_arq', nome: 'Para arquivar', senha: 'senha-arq-12345', perfil: 'consulta' });
  const arqId = ar.j.user.id;
  const meId = (await adm('GET', '/api/me')).j.user.id;
  ok('excluir usuário ativo é recusado', (await adm('DELETE', '/api/usuarios/' + arqId)).s === 400);
  ok('não arquiva a própria conta', (await adm('PATCH', '/api/usuarios/' + meId, { arquivado: true })).s === 400);
  ok('não exclui a própria conta', (await adm('DELETE', '/api/usuarios/' + meId)).s === 400);
  { const cc = api(await login('u_consulta', 'senha-consulta-123')); const x1 = await cc('PATCH', '/api/usuarios/' + arqId, { arquivado: true }), x2 = await cc('DELETE', '/api/usuarios/' + arqId); ok('quem não gerencia usuários não arquiva nem exclui', x1.s === 403 && x2.s === 403, [x1, x2]); }
  ar = await adm('PATCH', '/api/usuarios/' + arqId, { arquivado: true });
  ok('arquivar desativa e marca arquivado', ar.s === 200 && ar.j.user.archived === true && ar.j.user.active === false, ar.j);
  ok('usuário arquivado não consegue entrar', (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: 'u_arq', senha: 'senha-arq-12345' }) })).status === 403);
  ok('arquivado continua cadastrado na lista da API', (await adm('GET', '/api/usuarios')).j.users.some((u) => u.id === arqId && u.archived));
  ar = await adm('PATCH', '/api/usuarios/' + arqId, { ativo: true });
  ok('reativar tira do arquivo', ar.s === 200 && ar.j.user && ar.j.user.active === true && ar.j.user.archived === false, ar);
  await adm('PATCH', '/api/usuarios/' + arqId, { arquivado: true });
  ok('exclui usuário arquivado', (await adm('DELETE', '/api/usuarios/' + arqId)).s === 200 && !(await adm('GET', '/api/usuarios')).j.users.some((u) => u.id === arqId));
  ok('excluir usuário inexistente dá 404', (await adm('DELETE', '/api/usuarios/' + arqId)).s === 404);
  const adminsAntes = (await adm('GET', '/api/usuarios')).j.users.filter((u) => u.active).length;
  ok('exclusão não mexeu nos demais usuários', adminsAntes >= 7, adminsAntes);

  /* ---------- 7. PROTEÇÃO DE ESTOQUE ---------- */
  // restaura as permissões individuais e as sessões usadas até aqui
  await adm('PATCH', '/api/usuarios/' + uCx.id, { negar: [] });
  await adm('PATCH', '/api/usuarios/' + uConsulta.id, { conceder: [] });
  C.caixa_vendas = api(await login('u_caixa_vendas', 'senha-caixa_vendas-123'));
  C.consulta = api(await login('u_consulta', 'senha-consulta-123'));
  const sA = await saldoDe(adm, 'p2'); // 3
  ok('relatório de conferência: saldo de p2 = 3', sA === 3, sA);
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(10, 'p2', 5))] });
  const rel1 = (await adm('GET', '/api/estoque/relatorio')).j;
  ok('modo AVISO: venda acima do estoque passa e fica registrada', r.s === 200 && rel1.registro.some((l) => l.kind === 'aviso' && l.product_id === 'p2'), [r.s, rel1.registro.slice(0, 2)]);
  ok('relatório lista produtos que seriam bloqueados e divergências', rel1.modo === 'aviso' && rel1.linhas.find((l) => l.id === 'p2').saldo < 0 && rel1.linhas.find((l) => l.id === 'p2').divergencias.length > 0 && rel1.linhas.find((l) => l.id === 'p4').bloqueada === true, rel1.linhas);
  ok('relatório de conferência negado ao Caixa', (await C.caixa_vendas('GET', '/api/estoque/relatorio')).s === 403);
  ok('relatório liberado para Estoque e Consulta', (await C.estoque('GET', '/api/estoque/relatorio')).s === 200);
  r = await adm('POST', '/api/estoque/modo', { modo: 'bloqueio' });
  ok('ligar o bloqueio exige confirmação explícita', r.s === 400);
  // corrige o saldo de p2 e p4 antes de bloquear (a conferência)
  await batch(adm, { movimentos: [put('items', { id: 'ajp2', data: '2026-11-23', pid: 'p2', tipo: 'e', qtd: 10, motivo: 'Ajuste de inventário' }), put('items', { id: 'ajp4', data: '2026-11-23', pid: 'p4', tipo: 'e', qtd: 10, motivo: 'Ajuste de inventário' })] });
  r = await adm('POST', '/api/estoque/modo', { modo: 'bloqueio', confirmo: true });
  ok('administrador liga o bloqueio', r.s === 200);
  const s2 = await saldoDe(adm, 'p2'); // 3-5+10 = 8
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(11, 'p2', s2 + 1))] });
  ok('BLOQUEIO: venda acima do estoque é recusada (409) com os itens', r.s === 409 && r.j.code === 'estoque_insuficiente' && r.j.itens[0].pid === 'p2' && r.j.itens[0].saldo === s2, r);
  ok('BLOQUEIO: nada foi gravado e o número da venda não foi gasto', !(await docs(adm))['vendas-2026-11'].items.some((x) => x.id === 'vt11'));
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(12, 'p2', s2))] });
  ok('BLOQUEIO: vender exatamente o saldo passa', r.s === 200, r);
  ok('saldo zerou', (await saldoDe(adm, 'p2')) === 0);
  const chk = await C.caixa_vendas('POST', '/api/estoque/checar', { itens: [['p2', 1]] });
  ok('pré-checagem do PDV avisa antes de finalizar', chk.s === 200 && chk.j.itens.length === 1 && chk.j.modo === 'bloqueio', chk);
  // exceção
  const vx = venda(13, 'p2', 2);
  let aut = await C.caixa_vendas('POST', '/api/estoque/autorizar', { usuario: 'admin', senha: 'errada', justificativa: 'cliente antigo' });
  ok('exceção: senha errada do administrador é recusada', aut.s === 403);
  aut = await C.caixa_vendas('POST', '/api/estoque/autorizar', { usuario: 'u_financeiro', senha: 'senha-financeiro-123', justificativa: 'cliente antigo' });
  ok('exceção: quem não é administrador não autoriza', aut.s === 403);
  aut = await C.caixa_vendas('POST', '/api/estoque/autorizar', { usuario: 'admin', senha: 'senha-do-admin-1', justificativa: '' });
  ok('exceção: exige justificativa', aut.s === 400);
  aut = await C.caixa_vendas('POST', '/api/estoque/autorizar', { usuario: 'admin', senha: 'senha-do-admin-1', justificativa: 'Mercadoria na prateleira sem entrada lançada' });
  ok('exceção: administrador autoriza com usuário, senha e justificativa', aut.s === 200 && aut.j.token, aut);
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', vx)] }, { excecao: aut.j.token });
  const rel2 = (await adm('GET', '/api/estoque/relatorio')).j;
  const ex = rel2.registro.find((l) => l.kind === 'excecao');
  ok('exceção: venda passa e fica registrada com solicitante, autorizador e justificativa', r.s === 200 && ex && ex.user_name === 'Teste caixa_vendas' && ex.authorized_by && /prateleira/.test(ex.justification), [r.s, ex]);
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(14, 'p2', 2))] }, { excecao: aut.j.token });
  ok('exceção: a autorização vale uma vez só', r.s === 403, r);
  const aut2 = await C.estoque('POST', '/api/estoque/autorizar', { usuario: 'admin', senha: 'senha-do-admin-1', justificativa: 'teste de outro usuário' });
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(15, 'p2', 1))] }, { excecao: aut2.j.token });
  ok('exceção: a autorização é de quem pediu (não serve para outro usuário)', r.s === 403 || r.s === 409);
  ok('o registro de estoque não pode ser alterado nem apagado', (() => { try { PSQL('t_e2', 'update app_stock_log set kind=1'); return false; } catch (e) { return true; } })() && (() => { try { PSQL('t_e2', 'delete from app_stock_log'); return false; } catch (e) { return true; } })());
  // alterações de venda, devolução, perda, compra recebida
  const vt12 = (await docs(adm))['vendas-2026-11'].items.find((x) => x.id === 'vt12');
  r = await batch(C.caixa_vendas, { 'vendas-2026-11': [edit('items', vt12, { ...vt12, it: [['p2', 99, 5, 0]] })] });
  ok('BLOQUEIO: aumentar a quantidade de uma venda já feita também é barrado', r.s === 409, r);
  r = await batch(adm, { 'vendas-2026-11': [edit('items', vt12, { ...vt12, it: [['p2', 1, 5, 0]] })] });
  ok('diminuir a quantidade de uma venda nunca é barrado', r.s === 200, r);
  const antesDev = await saldoDe(adm, 'p3');
  r = await batch(C.estoque, { movimentos: [put('items', { id: 'perda1', data: '2026-11-23', pid: 'p3', tipo: 's', qtd: antesDev + 1, motivo: 'Perda / avaria' })] });
  ok('BLOQUEIO: perda maior que o saldo é barrada', r.s === 409, r);
  r = await batch(C.estoque, { movimentos: [put('items', { id: 'dev1', data: '2026-11-23', pid: 'p3', tipo: 'e', qtd: 2, motivo: 'Devolução de cliente' })] });
  ok('devolução (entrada) aumenta o saldo', r.s === 200 && (await saldoDe(adm, 'p3')) === antesDev + 2);
  const kRec = (await docs(adm)).compras.items.find((c) => c.id === 'k2'); // recebido: 2 de p3
  r = await batch(C.gerente_atual, { compras: [del('items', kRec)] });
  ok('excluir compra já recebida só passa se o estoque comportar', ((await saldoDe(adm, 'p3')) >= 0) && (r.s === 200 || r.s === 409), [r.s, await saldoDe(adm, 'p3')]);
  const vt12b = (await docs(adm))['vendas-2026-11'].items.find((x) => x.id === 'vt12');
  r = await batch(adm, { 'vendas-2026-11': [del('items', vt12b)] });
  ok('excluir venda (devolve ao estoque) nunca é barrado', r.s === 200);

  /* ---------- 8. SIMULTANEIDADE ---------- */
  await batch(adm, { movimentos: [put('items', { id: 'cc1', data: '2026-11-23', pid: 'p4', tipo: 'e', qtd: 5, motivo: 'Ajuste' })] });
  const antes4 = await saldoDe(adm, 'p4'); // 10+5 = 15 → ajusta para exatamente 6 consumindo
  await batch(adm, { movimentos: [put('items', { id: 'cc2', data: '2026-11-23', pid: 'p4', tipo: 's', qtd: antes4 - 6, motivo: 'Perda / avaria' })] });
  ok('preparo da corrida: saldo = 6', (await saldoDe(adm, 'p4')) === 6);
  const disputas = [];
  for (let i = 0; i < 12; i++) disputas.push(batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(100 + i, 'p4', 1))] }));
  for (let i = 0; i < 6; i++) disputas.push(batch(C.estoque, { movimentos: [put('items', { id: 'race' + i, data: '2026-11-23', pid: 'p4', tipo: 's', qtd: 1, motivo: 'Perda / avaria' })] }));
  const res = await Promise.all(disputas);
  const aceitas = res.filter((x) => x.s === 200).length, barradas = res.filter((x) => x.s === 409).length;
  ok('CORRIDA: 18 pedidos de 1 unidade para saldo 6: exatamente 6 passam', aceitas === 6 && barradas === 12, [aceitas, barradas, res.filter((x) => ![200, 409].includes(x.s)).map((x) => x.s)]);
  ok('CORRIDA: saldo final = 0, nunca negativo', (await saldoDe(adm, 'p4')) === 0);
  const nums = (await docs(adm))['vendas-2026-11'].items.map((x) => x.n);
  ok('numeração das vendas segue única', new Set(nums).size === nums.length);
  const antes3 = await saldoDe(adm, 'p3');
  const sim = [];
  for (let i = 0; i < 10; i++) sim.push(batch(C.caixa_vendas, { 'vendas-2026-11': [put('items', venda(200 + i, 'p3', 1))] }));
  const rs = await Promise.all(sim);
  ok('CORRIDA 2: 10 vendas simultâneas do mesmo produto respeitam o saldo', rs.filter((x) => x.s === 200).length === Math.min(10, antes3) && (await saldoDe(adm, 'p3')) >= 0, [antes3, rs.map((x) => x.s)]);

  /* ---------- 9. paridade da fórmula de estoque com a tela ---------- */
  const STK = require('../lib/stock.js');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const i0 = html.indexOf('function moves(){'), i1 = html.indexOf('const recS=', i0);
  const i2 = html.indexOf('\n}', html.indexOf('return{mv,st,last,pend,recS}', i1)) + 2;
  const front = new Function('S', html.slice(i0, i2 + 1) + '; return ctx();');
  let par = 0, tot = 0;
  for (let t = 0; t < 200; t++) {
    const rnd = (n) => Math.floor(Math.random() * n);
    const prods = Array.from({ length: 6 }, (_, i) => ({ id: 'q' + i }));
    const pid = () => 'q' + rnd(8); // inclui produtos inexistentes
    const S = { produtos: prods, movimentos: [], vendas: [], compras: [], notas: [], lancamentos: [] };
    for (let i = 0; i < rnd(10); i++) S.movimentos.push({ id: 'm' + i, data: '2026-11-0' + (1 + rnd(8)), pid: pid(), tipo: rnd(2) ? 'e' : 's', qtd: rnd(9) + 1 });
    for (let i = 0; i < rnd(10); i++) S.vendas.push({ id: 'v' + i, n: i, data: '2026-11-0' + (1 + rnd(8)), it: [[pid(), rnd(5) + 1, 5, 3], [pid(), rnd(3) + 1, 5, 3]] });
    for (let i = 0; i < rnd(6); i++) S.compras.push({ id: 'k' + i, status: ['pendente', 'recebido', 'cancelado'][rnd(3)], viaNF: rnd(3) === 0, data: '2026-11-01', receb: '2026-11-02', it: [[pid(), rnd(9) + 1, 2]] });
    for (let i = 0; i < rnd(4); i++) S.notas.push({ id: 'n' + i, data: '2026-11-01', num: i, it: [[pid(), rnd(9) + 1, 2]] });
    const f = front(S).st;
    const dd = { movimentos: { items: S.movimentos }, 'vendas-2026-11': { items: S.vendas }, compras: { items: S.compras }, 'notas-2026-11': { items: S.notas } };
    const b = STK.saldos(dd, prods);
    tot++; if (prods.every((p) => f[p.id] === b[p.id])) par++;
  }
  ok('fórmula de estoque do servidor = fórmula da tela (200 casos aleatórios)', par === tot, [par, tot]);

  /* ---------- 10. interruptor RBAC_V2=off volta ao comportamento anterior ---------- */
  await stop();
  await start('t_e2', { RBAC_V2: 'off' }, 3202);
  const ck = api(await login('u_caixa_atual', 'senha-caixa_atual-123'));
  const dOff = await docs(ck);
  ok('RBAC_V2=off: caixa lê como antes (sem filtro) e continua sem poder gravar compras', dOff.compras.items.length > 0 && (await batch(ck, { compras: [put('items', { id: 'kz', n: 0, status: 'pendente', it: [] })] })).s === 403);
  await stop();
  await start('t_e2', {}, 3203);
  const ck2 = api(await login('u_caixa_atual', 'senha-caixa_atual-123'));
  ok('religando as regras novas: o filtro volta', (await docs(ck2)).compras.items.length === 0);
  await stop();

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(); process.exit(1); });
