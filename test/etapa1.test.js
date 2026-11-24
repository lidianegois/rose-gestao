'use strict';
/* Testes da Etapa 1 (migrações + simultaneidade) contra um PostgreSQL real.
 * Uso: PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/etapa1.test.js */
const assert = require('assert');
const { execSync } = require('child_process');
const D = require('../public/docdiff.js');
const PSQL = (db, sql) => execSync(`psql -X -q -A -t -h ${process.env.PGHOST} -p ${process.env.PGPORT} -U postgres -d ${db} -c ${JSON.stringify(sql)}`).toString().trim();
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name + (extra ? ' -> ' + extra : '')); } };
const fresh = (db) => { try { execSync(`dropdb -h ${process.env.PGHOST} -p ${process.env.PGPORT} -U postgres --if-exists ${db}`); } catch (e) { /* ok */ } execSync(`createdb -h ${process.env.PGHOST} -p ${process.env.PGPORT} -U postgres ${db}`); };
const open = async (db) => { process.env.DATABASE_URL = `postgres://postgres@localhost:5433/${db}`; delete require.cache[require.resolve('../storage.js')]; const s = require('../storage.js').createStore(); await s.init(); return s; };
const venda = (i, extra) => ({ id: 'v' + i, n: 9999, data: '2026-11-23', pag: 'Pix', it: [['p1', 1, 5, 3]], ...extra });
const put = (k, rec) => ({ k, op: 'put', id: rec.id, before: null, after: rec });
const dados = async (s, id) => ((await s.list('loja')).find((d) => d.id === id) || {}).data;

(async () => {
  /* ---------- 1. migrações ---------- */
  fresh('t_mig');
  let s = await open('t_mig');
  const NMIG = String(require('fs').readdirSync('db/migrations').filter((f) => /^\d+_.*\.sql$/.test(f)).length);
  ok('migrações aplicadas em banco vazio (todas as dos arquivos, incluindo a 004)', PSQL('t_mig', "select count(*) from schema_migrations") === NMIG && PSQL('t_mig', "select count(*) from schema_migrations where version='004'") === '1');
  ok('migração 004 criou a tabela audit_log vazia', PSQL('t_mig', "select count(*) from audit_log") === '0');
  await s.close(); s = await open('t_mig');
  ok('segunda inicialização não reaplica', PSQL('t_mig', "select count(*) from schema_migrations") === NMIG);
  ok('coluna rev e contadores existem', PSQL('t_mig', "select count(*) from information_schema.columns where table_name='app_docs' and column_name='rev'") === '1' && PSQL('t_mig', 'select count(*) from app_counters') === '2');
  await s.close();

  /* ---------- 2. migração sobre dados existentes (cópia do formato de produção) ---------- */
  fresh('t_dados');
  execSync(`psql -X -q -h ${process.env.PGHOST} -p ${process.env.PGPORT} -U postgres -d t_dados -f db/migrations/000_base.sql`);
  const it = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ({ id: 'v' + (a + i), n: a + i, data: '2026-10-05', pag: 'Pix', it: [['p1', 1, 5, 3]] }));
  const antes = { 'cadastros': { clientes: [{ id: 'c1', nome: 'Ana' }], produtos: [{ id: 'p1', nome: 'Arroz', preco: 5 }], fornecedores: [], seq: { venda: 120, compra: 7 }, config: { taxaCred: 3 } },
    'vendas-2026-10': { items: it(1, 80) }, 'vendas-2026-11': { items: it(81, 120) }, 'compras': { items: [{ id: 'c1', n: 7, status: 'pendente', it: [] }, { id: 'c2', n: 6, status: 'ok', it: [] }] }, 'lancamentos': { items: [{ id: 'l1', valor: 10 }] }, 'caixas': { items: [] }, 'movimentos': { items: [] } };
  for (const [id, d] of Object.entries(antes)) PSQL('t_dados', `insert into app_docs(col,id,data) values ('loja','${id}','${JSON.stringify(d).replace(/'/g, "''")}'::jsonb)`);
  const sumAntes = PSQL('t_dados', "select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs");
  s = await open('t_dados');
  ok('migração 004 aplicada sobre os dados existentes, com audit_log vazia', PSQL('t_dados', "select count(*) from schema_migrations where version='004'") === '1' && PSQL('t_dados', 'select count(*) from audit_log') === '0');
  ok('migração sobre dados: dados idênticos', PSQL('t_dados', "select md5(string_agg(id||md5(data::text),'' order by id)) from app_docs") === sumAntes);
  ok('contador de vendas = maior número existente (120)', PSQL('t_dados', "select value from app_counters where name='venda'") === '120');
  ok('contador de compras = 7', PSQL('t_dados', "select value from app_counters where name='compra'") === '7');
  ok('todos os documentos com rev 1', PSQL('t_dados', "select count(*) from app_docs where rev=1") === '7');
  const cad = await dados(s, 'cadastros');
  ok('cadastros devolve a numeração do servidor', cad.seq.venda === 120 && cad.seq.compra === 7);

  /* ---------- 3. numeração única sob concorrência ---------- */
  const N = 60;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => s.applyBatch('loja', { 'vendas-2026-11': [put('items', venda(1000 + i))] }, {})));
  ok('60 vendas simultâneas gravadas', rs.every((r) => r.ok));
  const nums = rs.map((r) => r.assigned['vendas-2026-11']['v' + (1000 + rs.indexOf(r))]).sort((a, b) => a - b);
  ok('números únicos', new Set(nums).size === N);
  ok('números contínuos 121..180 (sem buracos)', nums[0] === 121 && nums[N - 1] === 180 && nums.every((n, i) => n === 121 + i));
  ok('contador no banco = 180', PSQL('t_dados', "select value from app_counters where name='venda'") === '180');
  const v11 = await dados(s, 'vendas-2026-11');
  ok('nenhuma venda perdida (40 + 60)', v11.items.length === 100 && new Set(v11.items.map((x) => x.n)).size === 100);

  /* ---------- 4. sobrescrita: registros diferentes somam, o mesmo registro conflita ---------- */
  const l0 = { id: 'l1', valor: 10 };
  const A = { 'lancamentos': [{ k: 'items', op: 'put', id: 'l1', before: l0, after: { id: 'l1', valor: 10, pago: '2026-11-23' } }] };
  const Bn = { 'lancamentos': [put('items', { id: 'l2', valor: 99 })] };
  const [ra, rb] = await Promise.all([s.applyBatch('loja', A, {}), s.applyBatch('loja', Bn, {})]);
  const lan = await dados(s, 'lancamentos');
  ok('A (editar l1) e B (criar l2) ao mesmo tempo: os dois ficam', ra.ok && rb.ok && lan.items.length === 2 && lan.items.find((x) => x.id === 'l1').pago === '2026-11-23');
  const X = { 'lancamentos': [{ k: 'items', op: 'put', id: 'l1', before: { id: 'l1', valor: 10, pago: '2026-11-23' }, after: { id: 'l1', valor: 10, pago: '2026-11-23', vpago: 10 } }] };
  const Y = { 'lancamentos': [{ k: 'items', op: 'put', id: 'l1', before: { id: 'l1', valor: 10, pago: '2026-11-23' }, after: { id: 'l1', valor: 777, pago: '2026-11-23' } }] };
  const [rx, ry] = await Promise.all([s.applyBatch('loja', X, {}), s.applyBatch('loja', Y, {})]);
  ok('mesmo registro ao mesmo tempo: um grava, o outro recebe conflito', [rx.ok, ry.ok].filter(Boolean).length === 1 && [rx, ry].some((r) => !r.ok && r.conflicts.length === 1));
  const l1 = (await dados(s, 'lancamentos')).items.find((x) => x.id === 'l1');
  ok('o registro tem só a alteração de quem gravou (sem mistura)', (l1.vpago === 10 && l1.valor === 10) || (l1.valor === 777 && l1.vpago === undefined));
  const rdel = await s.applyBatch('loja', { 'lancamentos': [{ k: 'items', op: 'del', id: 'l2', before: { id: 'l2', valor: 1 } }] }, {});
  ok('apagar registro que mudou por outra pessoa: conflito', !rdel.ok && (await dados(s, 'lancamentos')).items.some((x) => x.id === 'l2'));

  const dA = { 'lancamentos': [{ k: 'items', op: 'put', id: 'l2', before: { id: 'l2', valor: 99 }, after: { id: 'l2', valor: 99, desc: 'texto de A' } }] };
  const dB = { 'lancamentos': [{ k: 'items', op: 'put', id: 'l2', before: { id: 'l2', valor: 99 }, after: { id: 'l2', valor: 99, desc: 'texto de B' } }] };
  const da = await s.applyBatch('loja', dA, {}), db_ = await s.applyBatch('loja', dB, {});
  ok('duas edições do mesmo campo (desc): a segunda recebe conflito, nada se perde em silêncio', da.ok && !db_.ok && (await dados(s, 'lancamentos')).items.find((x) => x.id === 'l2').desc === 'texto de A');

  /* ---------- 5. atomicidade ---------- */
  const rev0 = PSQL('t_dados', "select rev from app_docs where id='vendas-2026-11'"), c0 = PSQL('t_dados', "select value from app_counters where name='venda'");
  const rat = await s.applyBatch('loja', { 'vendas-2026-11': [put('items', venda(5000))], 'lancamentos': [{ k: 'items', op: 'put', id: 'l1', before: { id: 'l1', valor: 1 }, after: { id: 'l1', valor: 2 } }] }, {});
  ok('lote com um conflito é recusado inteiro', !rat.ok);
  ok('nada da venda foi gravado (documento e rev intactos)', PSQL('t_dados', "select rev from app_docs where id='vendas-2026-11'") === rev0 && !(await dados(s, 'vendas-2026-11')).items.some((x) => x.id === 'v5000'));
  ok('o número não foi consumido (contador igual)', PSQL('t_dados', "select value from app_counters where name='venda'") === c0);

  /* ---------- 6. repetição do mesmo pedido (rede caiu e o navegador reenviou) ---------- */
  const lote = { 'vendas-2026-11': [put('items', venda(7000))] };
  const r1 = await s.applyBatch('loja', lote, {}), r2 = await s.applyBatch('loja', lote, {});
  ok('reenvio não duplica a venda', r2.ok && (await dados(s, 'vendas-2026-11')).items.filter((x) => x.id === 'v7000').length === 1);
  ok('reenvio devolve o mesmo número', r1.assigned['vendas-2026-11'].v7000 === r2.assigned['vendas-2026-11'].v7000);

  /* ---------- 7. importação/restauração (bulk) mantém os números ---------- */
  const rb2 = await s.applyBatch('loja', { 'vendas-2026-09': [put('items', { id: 'vx1', n: 4000, data: '2026-09-01', pag: 'Pix', it: [] }), put('items', { id: 'vx2', n: 4001, data: '2026-09-01', pag: 'Pix', it: [] })] }, { bulk: true });
  ok('bulk mantém os números originais', rb2.ok && (await dados(s, 'vendas-2026-09')).items.map((x) => x.n).join() === '4000,4001');
  const rn = await s.applyBatch('loja', { 'vendas-2026-11': [put('items', venda(8000))] }, {});
  ok('próxima venda continua depois do maior número (4002)', rn.assigned['vendas-2026-11'].v8000 === 4002);

  /* ---------- 8. cadastros: numeração é do servidor; mudanças em registros e configuração ---------- */
  const rc = await s.applyBatch('loja', { 'cadastros': [{ k: 'seq', op: 'field', key: 'venda', before: 1, after: 1 }, { k: 'config', op: 'field', key: 'taxaDeb', before: null, bAbs: true, after: 1.5, aAbs: false }, put('clientes', { id: 'c2', nome: 'Beto' })] }, {});
  const cad2 = await dados(s, 'cadastros');
  ok('config e clientes gravados, seq enviada pelo cliente ignorada', rc.ok && cad2.config.taxaDeb === 1.5 && cad2.config.taxaCred === 3 && cad2.clientes.length === 2 && cad2.seq.venda === 4002);

  /* ---------- 9. estresse: 150 gravações simultâneas em registros diferentes do mesmo documento ---------- */
  const rr = await Promise.all(Array.from({ length: 150 }, (_, i) => s.applyBatch('loja', { 'movimentos': [put('items', { id: 'm' + i, tipo: 'e', qtd: 1, pid: 'p1' })] }, {})));
  ok('150 gravações simultâneas: nenhuma perdida', rr.every((r) => r.ok) && (await dados(s, 'movimentos')).items.length === 150);
  ok('rev subiu uma vez por gravação', Number(PSQL('t_dados', "select rev from app_docs where id='movimentos'")) === 151);

  /* ---------- 10. diff cliente/servidor: documento grande com poucas mudanças ---------- */
  const bigBase = { items: Array.from({ length: 3000 }, (_, i) => ({ id: 'z' + i, v: i })) };
  const bigNext = D.clone(bigBase); bigNext.items[10].v = -1; bigNext.items.push({ id: 'znovo', v: 1 });
  ok('diff de 3000 registros gera só 2 mudanças', D.diffDoc('lancamentos', bigBase, bigNext).length === 2);

  await s.close();
  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
