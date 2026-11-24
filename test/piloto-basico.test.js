'use strict';
/* Piloto do plano Básico (local, dados fictícios): teto do plano no servidor, matriz de acesso por API e URL direta,
 * preservação de dados/senha/sessão, perfil interno TI-Lidiane com concessões, estoque negativo em dados isolados.
 * Uso: PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/piloto-basico.test.js */
const { execSync, spawn, spawnSync } = require('child_process');
const H = process.env.PGHOST, PT = process.env.PGPORT;
const PSQL = (db, sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d ${db} -c ${JSON.stringify(sql)} 2>&1 || true`).toString().trim();
const fresh = (db) => { try { execSync(`dropdb -h ${H} -p ${PT} -U postgres --if-exists ${db}`); } catch (e) { /* ok */ } execSync(`createdb -h ${H} -p ${PT} -U postgres ${db}`); };
let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
let proc = null, base = '';
async function start(db, env, port) {
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['server.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${db}`, PORT: String(port), SESSION_SECRET: 'segredo-de-teste', APP_USER: 'rose', APP_PASSWORD: 'senha-da-rose-1', NODE_PATH: 'test/shim', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu: ' + log);
}
const stop = async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); proc = null; } };
async function login(u, s) { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: u, senha: s }) }); if (!r.ok) throw new Error('login ' + u + ' ' + r.status); return (r.headers.get('set-cookie') || '').split(';')[0]; }
const api = (ck) => async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) { /* */ } return { s: r.status, j }; };
const page = async (ck, p) => { const r = await fetch(base + p, { headers: { cookie: ck }, redirect: 'manual' }); return r.status; };
const put = (k, rec) => ({ k, op: 'put', id: rec.id, before: null, after: rec });
const batch = (c, d, e) => c('POST', '/api/col/loja/_batch', { docs: d, ...(e || {}) });
const setPlano = (db, p) => PSQL(db, `insert into app_settings(key,value) values ('plano','"${p}"') on conflict (key) do update set value='"${p}"'`);
const dataHash = (db) => PSQL(db, "select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs");
const userHash = (db) => PSQL(db, "select md5(string_agg(id||username||pass||pwv::text||role||coalesce(role_id,'')||active::text,'|' order by id)) from app_users");

const PERFIS = ['financeiro', 'caixa_vendas', 'estoque', 'compras', 'consulta', 'gerente_atual', 'caixa_atual'];
const FORA = ['analise.ver', 'financeiro.solicitar_pagamento', 'aprovacao.ver', 'aprovacao.aprovar', 'aprovacao.config', 'backup.restaurar', 'dados.apagar'];

(async () => {
  /* ======== CENÁRIO BÁSICO ======== */
  fresh('t_pbas');
  await start('t_pbas', {}, 3400); // sem plano configurado: como antes (completo)
  const admC = api(await login('rose', 'senha-da-rose-1'));
  const me0 = (await admC('GET', '/api/me')).j.user;
  ok('sem plano configurado, tudo como antes (plano completo, DRE disponível)', me0.plano === 'completo' && me0.perm.includes('financeiro.dre') && me0.perm.includes('dados.apagar'), me0.plano);
  /* dados fictícios com a estrutura da base atual */
  const seed = {
    cadastros: [put('produtos', { id: 'p1', cod: 'A1', nome: 'Arroz', custo: 22, preco: 29.9, min: 5, ean: '7891000100103' }), put('clientes', { id: 'c1', nome: 'Maria Teste', prazo: 30 }), put('fornecedores', { id: 'f1', nome: 'Atacado Teste' }),
      { k: 'config', op: 'field', key: 'taxaDeb', before: null, bAbs: true, after: 0, aAbs: false }],
    movimentos: [put('items', { id: 'm1', data: '2026-11-20', pid: 'p1', tipo: 'e', qtd: 30, motivo: 'inicial' })],
    'vendas-2026-11': [put('items', { id: 'v1', n: 1, data: '2026-11-21', pag: 'Pix', it: [['p1', 2, 29.9, 22]] })],
    'notas-2026-11': [put('items', { id: 'n1', num: '4521', data: '2026-11-22', emissao: '2026-11-22', fid: 'f1', emit: 'Atacado Teste', total: 100, it: [['p1', 5, 20, '', '', '']] })],
    compras: [put('items', { id: 'k1', n: 1, data: '2026-11-20', fid: 'f1', status: 'pendente', it: [['p1', 5, 22]] })],
    lancamentos: [put('items', { id: 'l1', tipo: 'd', cat: 'Outros', desc: 'Aluguel', valor: 800, data: '2026-11-22', venc: '2026-11-30', pago: '', vpago: 0, origem: '' })],
    caixas: [put('items', { id: 'x1', data: '2026-11-21', ab: '08:00', fe: '17:00', op: 'Rose', inicial: 100, mov: [], fechado: '2026-11-21', contado: 100, dif: 0 })],
  };
  ok('administradora (plano completo) grava dados fictícios em lote', (await batch(admC, seed, { bulk: true })).s === 200);
  const rose = (await admC('GET', '/api/usuarios')).j.users.find((u) => u.username === 'rose');
  ok('conta da Rose é administradora', rose.profile === 'administrador', rose);
  const ckAntigo = await login('rose', 'senha-da-rose-1'); // sessão aberta antes da mudança de plano
  const hD0 = dataHash('t_pbas'), hU0 = userHash('t_pbas');
  const rows0 = PSQL('t_pbas', 'select count(*) from app_docs');
  await stop();
  setPlano('t_pbas', 'basico'); PSQL('t_pbas', `insert into app_settings(key,value) values ('empresa_nome','"Rose Mercearia e Bazar"') on conflict (key) do update set value=excluded.value`);
  await start('t_pbas', {}, 3401);
  ok('preservação: documentos idênticos depois de aplicar o plano', dataHash('t_pbas') === hD0 && PSQL('t_pbas', 'select count(*) from app_docs') === rows0);
  ok('preservação: usuários, senha (hash), versão de sessão e perfil idênticos', userHash('t_pbas') === hU0);
  const R = api(ckAntigo);
  const meB = await R('GET', '/api/me');
  ok('preservação: a sessão aberta antes do plano continua válida', meB.s === 200, meB.s);
  ok('preservação: a senha atual continua entrando', (await login('rose', 'senha-da-rose-1')).length > 5);
  const rb = meB.j.user;
  ok('/api/me: plano básico e nome da empresa', rb.plano === 'basico' && rb.empresa === 'Rose Mercearia e Bazar', [rb.plano, rb.empresa]);
  ok('Rose continua administradora', rb.profile === 'administrador');
  ok('plano limita a administradora: nenhuma permissão fora do Básico', FORA.every((p) => !rb.perm.includes(p)), FORA.filter((p) => rb.perm.includes(p)));
  const DENTRO = ['painel.ver', 'caixa.ver', 'caixa.vender', 'vendas.ver', 'clientes.ver', 'fiado.receber', 'produtos.ver', 'produtos.editar', 'produtos.ver_custo', 'produtos.ver_margem', 'estoque.ver', 'estoque.movimentar', 'estoque.conferir', 'notas.ver', 'notas.editar', 'notas.excluir', 'compras.ver', 'compras.editar', 'compras.receber', 'fornecedores.ver', 'financeiro.ver', 'financeiro.lancar', 'financeiro.baixar', 'financeiro.editar', 'financeiro.excluir', 'auditoria.ver', 'usuarios.gerir', 'backup.copiar', 'config.editar', 'estoque.excecao'];
  ok('Rose mantém tudo o que o Básico inclui (notas, XML, financeiro essencial, custo, margem, histórico)', DENTRO.every((p) => rb.perm.includes(p)), DENTRO.filter((p) => !rb.perm.includes(p)));
  ok('menu: tem notas e financeiro, não tem análise', rb.tabs.includes('notas') && rb.tabs.includes('financeiro') && !rb.tabs.includes('analise'), rb.tabs);
  /* leitura e escrita pela API */
  const dd = (await R('GET', '/api/col/loja')).j.docs;
  ok('API lê dados com custo e notas existentes', dd.some((d) => d.id === 'notas-2026-11' && d.data.items.length === 1) && JSON.stringify(dd.find((d) => d.id === 'cadastros').data.produtos).includes('"custo":22'));
  const nova = { id: 'n2', num: '4522', data: '2026-11-24', emissao: '2026-11-24', fid: 'f1', emit: 'Atacado Teste', total: 50, it: [['p1', 2, 25, '', '', '']] };
  ok('API grava nota de entrada (importação)', (await batch(R, { 'notas-2026-11': [put('items', nova)] })).s === 200);
  ok('API grava lançamento e dá baixa (financeiro essencial)', (await batch(R, { lancamentos: [put('items', { id: 'l2', tipo: 'r', cat: 'Outros', desc: 'Receita avulsa', valor: 20, data: '2026-11-24', venc: '2026-11-24', pago: '2026-11-24', vpago: 20, origem: '' })] })).s === 200);
  ok('API: importação em lote (restaurar) negada', (await batch(R, { cadastros: [] }, { bulk: true })).s === 403);
  const delDoc = await R('DELETE', '/api/col/loja/cadastros');
  ok('API: apagar documento negado à Rose', delDoc.s === 403 && (await R('GET', '/api/col/loja')).j.docs.some((d) => d.id === 'cadastros'), delDoc);
  ok('API: apagar outros documentos (lançamentos, caixas) negado e dados intactos', (await R('DELETE', '/api/col/loja/lancamentos')).s === 403 && (await R('DELETE', '/api/col/loja/caixas')).s === 403 && (await R('GET', '/api/col/loja')).j.docs.some((d) => d.id === 'lancamentos'));
  const hist = await R('GET', '/api/historico');
  ok('Histórico: a administradora consulta (API)', hist.s === 200 && Array.isArray(hist.j.items));
  ok('Histórico: só leitura mesmo para a administradora', (await R('POST', '/api/historico', {})).s === 405 && (await R('DELETE', '/api/historico/1')).s === 405);
  ok('páginas por URL direta: histórico, conferência e usuários abrem para a Rose', (await page(ckAntigo, '/historico')) === 200 && (await page(ckAntigo, '/estoque-conferencia')) === 200 && (await page(ckAntigo, '/usuarios')) === 200);
  ok('Rose não cria perfil interno TI-Lidiane no plano Básico', (await R('POST', '/api/usuarios', { usuario: 'ti-x', nome: 'TI', senha: 'senha-ti-12345', perfil: 'ti_lidiane' })).s === 400);
  /* outros perfis: histórico por menu, URL e API; fora do plano; concessão fora do plano sem efeito */
  const C = {};
  for (const p of PERFIS) {
    const rr = await R('POST', '/api/usuarios', { usuario: 'u_' + p, nome: 'Teste ' + p, senha: 'senha-' + p + '-123', perfil: p });
    if (rr.s !== 201) console.log('criação falhou', p, rr.s, rr.j);
    C[p] = { ck: await login('u_' + p, 'senha-' + p + '-123') }; C[p].c = api(C[p].ck);
  }
  for (const p of PERFIS) {
    const c = C[p].c, m = (await c('GET', '/api/me')).j.user;
    ok(`${p}: sem link do Histórico (permissão ausente), /historico redireciona, API 403`, !m.perm.includes('auditoria.ver') && (await page(C[p].ck, '/historico')) === 303 && (await c('GET', '/api/historico')).s === 403 && (await c('GET', '/api/historico/1')).s === 403);
    ok(`${p}: nenhuma permissão fora do plano`, FORA.every((x) => !m.perm.includes(x)), FORA.filter((x) => m.perm.includes(x)));
    ok(`${p}: backup/apagar por API negados`, (await batch(c, { cadastros: [] }, { bulk: true })).s === 403 && (await c('DELETE', '/api/col/loja/cadastros')).s === 403);
  }
  /* concessão forçada de permissões fora do plano e do Histórico a outro perfil */
  const uids = (await R('GET', '/api/usuarios')).j.users; const fin = uids.find((u) => u.username === 'u_financeiro');
  const gr = await R('PATCH', '/api/usuarios/' + fin.id, { conceder: ['auditoria.ver', 'dados.apagar', 'backup.restaurar', 'analise.ver', 'usuarios.gerir'] });
  const finC = api(await login('u_financeiro', 'senha-financeiro-123')), finM = (await finC('GET', '/api/me')).j.user;
  ok('concessões fora do plano não têm efeito (Histórico, apagar, restaurar, análise, usuários)', gr.s === 200 && ['auditoria.ver', 'dados.apagar', 'backup.restaurar', 'analise.ver', 'usuarios.gerir'].every((x) => !finM.perm.includes(x)), finM.perm.filter((x) => ['auditoria.ver', 'dados.apagar', 'backup.restaurar', 'analise.ver', 'usuarios.gerir'].includes(x)));
  ok('perfil com concessão forçada continua sem Histórico por URL e API', (await page(await login('u_financeiro', 'senha-financeiro-123'), '/historico')) === 303 && (await finC('GET', '/api/historico')).s === 403 && (await finC('DELETE', '/api/col/loja/cadastros')).s === 403);
  /* escopo por perfil: nota e financeiro */
  ok('Estoque e Compras importam nota (permissão notas.editar); Caixa/Vendas não', (await batch(C.estoque.c, { 'notas-2026-11': [put('items', { ...nova, id: 'n3', num: '4523' })] })).s === 200 && (await batch(C.caixa_vendas.c, { 'notas-2026-11': [put('items', { ...nova, id: 'n4', num: '4524' })] })).s === 403);
  const cvDocs = (await C.caixa_vendas.c('GET', '/api/col/loja')).j.docs;
  ok('Caixa/Vendas: notas vazias e produtos sem custo', (cvDocs.find((d) => d.id === 'notas-2026-11') || { data: { items: [] } }).data.items.length === 0 && cvDocs.find((d) => d.id === 'cadastros').data.produtos.every((p) => p.custo === undefined));
  const mg = (await C.gerente_atual.c('GET', '/api/me')).j.user;
  ok('Gerente (atual) no Básico perde as que são só da administradora (usuários, configuração, excluir nota)', !mg.perm.includes('usuarios.gerir') && !mg.perm.includes('config.editar') && !mg.perm.includes('notas.excluir') && mg.perm.includes('notas.editar') && mg.perm.includes('financeiro.baixar'), mg.perm.length);
  ok('Gerente (atual): gerenciar usuários por API negado', (await C.gerente_atual.c('GET', '/api/usuarios')).s === 403 && (await page(C.gerente_atual.ck, '/usuarios')) === 303);
  ok('Financeiro: tudo do financeiro essencial, com DRE', finM.perm.includes('financeiro.baixar') && finM.perm.includes('financeiro.lancar') && finM.perm.includes('financeiro.dre'));
  /* o histórico registrou a concessão e a gravação da nota, com autor */
  const hv = (await R('GET', '/api/historico?limite=200')).j.items;
  ok('Histórico registra a concessão de permissões e a nota importada', hv.some((x) => x.acao === 'usuario_alterar') && hv.some((x) => /Nota fiscal/.test(x.resumo || '')), hv.slice(0, 3).map((x) => x.resumo));
  await stop();

  /* PLANO_ENFORCE=off: volta ao comportamento anterior sem desfazer nada */
  await start('t_pbas', { PLANO_ENFORCE: 'off' }, 3402);
  const mOff = (await api(await login('rose', 'senha-da-rose-1'))('GET', '/api/me')).j.user;
  ok('PLANO_ENFORCE=off: a Rose volta a ter DRE, análise e apagar dados; nada foi desfeito', mOff.perm.includes('financeiro.dre') && mOff.perm.includes('analise.ver') && mOff.perm.includes('dados.apagar'));
  await stop();

  /* ======== CENÁRIO COMPLETO (banco separado, TI-Lidiane) ======== */
  fresh('t_pcom');
  setPlano('t_pcom', 'completo') || 0;
  await start('t_pcom', { APP_USER: 'empresa', APP_PASSWORD: 'senha-empresa-1' }, 3403);
  const adm = api(await login('empresa', 'senha-empresa-1'));
  await batch(adm, { cadastros: [put('produtos', { id: 'q1', cod: 'TC1', nome: 'TC Arroz 5 kg', custo: 22, preco: 29.9, min: 5, ean: '7892000100100' })] }, { bulk: true });
  await stop();
  setPlano('t_pcom', 'completo');
  const sc = spawnSync('node', ['scripts/criar-ti-lidiane.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/t_pcom`, TI_SENHA: 'senha-ti-lidiane-1', PILOTO_BANCO: 't_pcom', NODE_PATH: 'test/shim' }, encoding: 'utf8' });
  ok('script cria o perfil e a conta TI-Lidiane no banco de teste (plano completo)', sc.status === 0 && /prontos/.test(sc.stdout), sc.stdout + sc.stderr);
  ok('o script não imprime a senha', !(sc.stdout + sc.stderr).includes('senha-ti-lidiane-1'));
  const sc2 = spawnSync('node', ['scripts/criar-ti-lidiane.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/t_pbas`, TI_SENHA: 'senha-ti-lidiane-1', PILOTO_BANCO: 't_pbas', NODE_PATH: 'test/shim' }, encoding: 'utf8' });
  ok('o script recusa criar a conta em banco com plano Básico', sc2.status === 2 && PSQL('t_pbas', "select count(*) from app_users where username='ti-lidiane'") === '0', sc2.stderr);
  await start('t_pcom', { APP_USER: 'empresa', APP_PASSWORD: 'senha-empresa-1' }, 3404);
  const ADM = api(await login('empresa', 'senha-empresa-1'));
  const tiCk = await login('ti-lidiane', 'senha-ti-lidiane-1'); const TI = api(tiCk);
  const mt = (await TI('GET', '/api/me')).j.user;
  const SENS = ['dados.apagar', 'backup.restaurar', 'usuarios.gerir', 'estoque.excecao', 'config.editar', 'aprovacao.aprovar', 'aprovacao.config'];
  ok('TI-Lidiane: plano completo, perfil TI-Lidiane', mt.plano === 'completo' && mt.profile === 'ti_lidiane' && mt.label === 'TI-Lidiane', [mt.plano, mt.profile]);
  ok('TI-Lidiane visualiza todas as funções (todas as permissões de ver, DRE, análise, histórico)', ['painel.ver', 'caixa.ver', 'vendas.ver', 'clientes.ver', 'produtos.ver', 'estoque.ver', 'notas.ver', 'compras.ver', 'fornecedores.ver', 'financeiro.ver', 'analise.ver', 'financeiro.dre', 'auditoria.ver', 'aprovacao.ver'].every((x) => mt.perm.includes(x)), mt.perm);
  ok('TI-Lidiane opera o dia a dia (vender, receber, comprar, lançar, importar nota)', ['caixa.vender', 'caixa.abrir_fechar', 'caixa.sangria', 'fiado.receber', 'compras.receber', 'financeiro.baixar', 'notas.editar', 'produtos.editar', 'estoque.movimentar'].every((x) => mt.perm.includes(x)));
  ok('TI-Lidiane: ações sensíveis fora do perfil', SENS.every((x) => !mt.perm.includes(x)), SENS.filter((x) => mt.perm.includes(x)));
  ok('TI-Lidiane: menu com todas as telas', ['painel', 'caixa', 'vendas', 'clientes', 'produtos', 'movimentacoes', 'notas', 'compras', 'fornecedores', 'financeiro', 'analise'].every((t) => mt.tabs.includes(t)), mt.tabs);
  ok('TI-Lidiane abre Histórico por menu, URL e API (leitura)', mt.perm.includes('auditoria.ver') && (await page(tiCk, '/historico')) === 200 && (await TI('GET', '/api/historico')).s === 200);
  ok('TI-Lidiane sem concessão: apagar, restaurar e gerenciar usuários negados', (await TI('DELETE', '/api/col/loja/cadastros')).s === 403 && (await batch(TI, { cadastros: [] }, { bulk: true })).s === 403 && (await TI('GET', '/api/usuarios')).s === 403 && (await page(tiCk, '/usuarios')) === 303);
  const tiU = (await ADM('GET', '/api/usuarios')).j.users.find((u) => u.username === 'ti-lidiane');
  const gc = await ADM('PATCH', '/api/usuarios/' + tiU.id, { conceder: ['dados.apagar'] });
  const TI2 = api(await login('ti-lidiane', 'senha-ti-lidiane-1'));
  const mt2 = (await TI2('GET', '/api/me')).j.user;
  ok('concessão individual de uma ação sensível vale só para ela e exige novo login', gc.s === 200 && mt2.perm.includes('dados.apagar') && !mt2.perm.includes('backup.restaurar') && (await TI('GET', '/api/me')).s === 401);
  ok('com a concessão, apaga documento no banco de teste', (await TI2('DELETE', '/api/col/loja/cadastros')).s === 200);
  const hc = (await ADM('GET', '/api/historico?limite=200')).j.items;
  ok('a concessão e o uso aparecem no Histórico com autor', hc.some((x) => x.acao === 'usuario_alterar' && /ti-lidiane/.test(x.resumo)) && hc.some((x) => x.acao === 'apagar_documento' && x.user_name === 'TI-Lidiane'), hc.slice(0, 4).map((x) => [x.acao, x.user_name]));
  await TI2('GET', '/api/me');
  const rv = await ADM('PATCH', '/api/usuarios/' + tiU.id, { conceder: [] });
  ok('revogar a concessão restabelece a negativa', rv.s === 200 && (await api(await login('ti-lidiane', 'senha-ti-lidiane-1'))('DELETE', '/api/col/loja/lancamentos')).s === 403);
  await stop();

  /* ======== ESTOQUE NEGATIVO EM DADOS ISOLADOS ======== */
  fresh('t_pneg');
  await start('t_pneg', { APP_USER: 'adm', APP_PASSWORD: 'senha-adm-12345' }, 3405);
  const A = api(await login('adm', 'senha-adm-12345'));
  await A('POST', '/api/usuarios', { usuario: 'caixa1', nome: 'Caixa', senha: 'senha-cx-12345', perfil: 'caixa_vendas' });
  const CX = api(await login('caixa1', 'senha-cx-12345'));
  await batch(A, { cadastros: [put('produtos', { id: 'z1', cod: 'Z1', nome: 'Arroz isolado', custo: 22, preco: 29.9, min: 5 })], movimentos: [put('items', { id: 'mz', data: '2026-11-20', pid: 'z1', tipo: 'e', qtd: 17, motivo: 'inicial' })] }, { bulk: true });
  const saldoZ = async () => ((await A('GET', '/api/estoque/relatorio')).j.linhas.find((l) => l.id === 'z1') || {}).saldo;
  const vend = (i, q) => ({ id: 'vz' + i, n: 0, data: '2026-11-23', pag: 'Dinheiro', it: [['z1', q, 29.9, 22]] });
  ok('estoque isolado: saldo inicial 17', (await saldoZ()) === 17);
  await A('POST', '/api/estoque/modo', { modo: 'aviso' });
  const ra = await batch(CX, { 'vendas-2026-11': [put('items', vend(1, 100))] });
  ok('modo AVISO: venda de 100 (saldo 17) é gravada e o saldo fica −83', ra.s === 200 && (await saldoZ()) === -83, [ra.s, await saldoZ()]);
  const rel = (await A('GET', '/api/estoque/relatorio')).j;
  ok('modo AVISO: fica registro de aviso', rel.registro.some((l) => l.kind === 'aviso' && l.product_id === 'z1'));
  await batch(A, { movimentos: [put('items', { id: 'mz2', data: '2026-11-23', pid: 'z1', tipo: 'e', qtd: 100, motivo: 'reposição' })] });
  ok('estoque isolado volta a 17 com a entrada de 100', (await saldoZ()) === 17);
  const antesVendas = PSQL('t_pneg', "select jsonb_array_length(data->'items') from app_docs where id='vendas-2026-11'");
  await A('POST', '/api/estoque/modo', { modo: 'bloqueio', confirmo: true });
  const rb2 = await batch(CX, { 'vendas-2026-11': [put('items', vend(2, 100))] });
  ok('modo BLOQUEIO: venda de 100 recusada com código de estoque, nada gravado', rb2.s === 409 && rb2.j.code === 'estoque_insuficiente' && (await saldoZ()) === 17 && PSQL('t_pneg', "select jsonb_array_length(data->'items') from app_docs where id='vendas-2026-11'") === antesVendas, rb2);
  ok('modo BLOQUEIO: fica registro de bloqueio', (await A('GET', '/api/estoque/relatorio')).j.registro.some((l) => l.kind === 'bloqueio'));
  const aut = await CX('POST', '/api/estoque/autorizar', { usuario: 'adm', senha: 'senha-adm-12345', justificativa: 'Mercadoria na prateleira sem entrada lançada' });
  const rex = await batch(CX, { 'vendas-2026-11': [put('items', vend(3, 100))] }, { excecao: aut.j.token });
  ok('modo BLOQUEIO + autorização da administradora: grava, saldo −83 e registro de exceção', rex.s === 200 && (await saldoZ()) === -83 && (await A('GET', '/api/estoque/relatorio')).j.registro.some((l) => l.kind === 'excecao'), [rex.s, await saldoZ()]);
  await stop();

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(); process.exit(1); });
