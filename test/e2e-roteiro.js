'use strict';
/* Roteiro de 7 dias (dados fictícios) rodando a tela de verdade.
 * Uso: node test/e2e-roteiro.js basico|completo   (precisa do PostgreSQL local; cria banco t_rot_<cenario>)
 * O servidor roda a partir de uma cópia em /tmp/rot_<cenario> com o gancho de teste window.__T (nunca vai para o código publicado). */
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const CEN = process.argv[2] === 'completo' ? 'completo' : 'basico';
const H = process.env.PGHOST || '/tmp/pgsock', PT = process.env.PGPORT || '5433';
const DB = 't_rot_' + CEN, DIR = '/tmp/rot_' + CEN, PORT = CEN === 'basico' ? 3510 : 3511, URL = 'http://localhost:' + PORT;
const PSQL = (sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d ${DB} -c ${JSON.stringify(sql)} 2>&1 || true`).toString().trim();
let pass = 0, fail = 0; const falhas = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; falhas.push(n); } console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : ' -> ' + JSON.stringify(x))); };
const near = (a, b) => Math.abs(a - b) < 0.005;

/* ---- cópia de teste com o gancho ---- */
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
execSync(`git ls-files -z --cached --others --exclude-standard | xargs -0 cp --parents -t ${DIR}`, { cwd: path.join(__dirname, '..') });
let html = fs.readFileSync(DIR + '/public/index.html', 'utf8');
const hook = "window.__T={get A(){return A},get S(){return S},get C(){return C},get CART(){return CART},pdvTot,pdvRest,cxRes,cxOpen,cashEv,caixa,mark,render,hoje,uid,fNotaXml,cliPag,vTotal,pagar:A.pagar,receber:A.receber};\n";
const cut = html.lastIndexOf('})();\n}\n</script>'); if (cut < 0) throw new Error('ponto de injeção não achado');
html = html.slice(0, cut) + hook + '})();\n}\n</script>' + html.slice(cut + '})();\n}\n</script>'.length);
fs.writeFileSync(DIR + '/public/index.html', html);

/* ---- banco, plano e servidor ---- */
try { execSync(`dropdb -h ${H} -p ${PT} -U postgres --if-exists ${DB}`); } catch (e) { /* ok */ } execSync(`createdb -h ${H} -p ${PT} -U postgres ${DB}`);
const ADM = CEN === 'basico' ? ['rose', 'senha-da-rose-1'] : ['mercado', 'senha-mercado-1'];
let proc = null;
async function start() {
  proc = spawn('node', ['server.js'], { cwd: DIR, env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${DB}`, PORT: String(PORT), SESSION_SECRET: 'segredo-de-teste', APP_USER: ADM[0], APP_PASSWORD: ADM[1], NODE_PATH: path.join(__dirname, 'shim') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(URL + '/health')).ok) return; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('servidor não subiu');
}
const stop = async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); proc = null; } };
const EAN = CEN === 'basico' ? ['7891000100103', '7891000200209', '7891000300305', '7891000400401'] : ['7892000100100', '7892000200206', '7892000300302', '7892000400408'];
const PRE = CEN === 'basico' ? '' : 'TC ';
const USER = CEN === 'basico' ? ADM : ['ti-lidiane', 'senha-ti-lidiane-1'];

(async () => {
  await start(); await stop();
  PSQL(`insert into app_settings(key,value) values ('plano','"${CEN}"'),('empresa_nome','"${CEN === 'basico' ? 'Rose Mercearia e Bazar' : 'Mercado Modelo (teste)'}"') on conflict (key) do update set value=excluded.value`);
  if (CEN === 'completo') {
    const sc = spawnSync('node', ['scripts/criar-ti-lidiane.js'], { cwd: DIR, env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${DB}`, TI_SENHA: USER[1], PILOTO_BANCO: DB, NODE_PATH: path.join(__dirname, 'shim') }, encoding: 'utf8' });
    ok('conta TI-Lidiane criada no cenário Completo', sc.status === 0, sc.stderr);
  }
  await start();

  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  const ev = (fn, arg) => pg.evaluate(([src, a]) => { const T = window.__T; return new Function('T', 'arg', 'const {A,S,C,CART,pdvTot,pdvRest,cxRes,cxOpen,cashEv,caixa,mark,render,hoje,uid,fNotaXml,cliPag,pagar,receber,vTotal}=T;return (' + src + ')(arg)')(T, a); }, [fn.toString(), arg]);
  const wait = (ms) => pg.waitForTimeout(ms);
  async function entrar(cred = USER) { await pg.goto(URL + '/login'); await pg.fill('#u', cred[0]); await pg.fill('#p', cred[1]); await pg.click('#go'); await pg.waitForURL(URL + '/'); await wait(1800); }
  /* a configuração (taxas = 0) é ajuste da administradora; a TI-Lidiane não tem config.editar */
  await entrar(ADM); await ev(() => { S.config = { ...(S.config || {}), taxaDeb: 0, taxaCred: 0, saldoIni: 0 }; mark('cadastros'); }); await wait(1500);
  if (CEN === 'completo') { await ctx.clearCookies(); await entrar(USER); }
  const me = await pg.evaluate(async () => (await (await fetch('/api/me')).json()).user);
  ok(`login ${USER[0]}: plano ${CEN} e nome da empresa`, me.plano === CEN && (CEN === 'basico' ? me.empresa === 'Rose Mercearia e Bazar' : /Mercado Modelo/.test(me.empresa)), [me.plano, me.empresa]);
  const brand = await pg.locator('.brand, .sbrand').first().innerText().catch(() => '');
  ok('cabeçalho mostra "Rose Mercearia e Bazar"' + (CEN === 'completo' ? ' (marca do sistema)' : ''), /Rose/.test(brand) || (await pg.content()).includes('Rose Mercearia e Bazar'));
  const modal = async (set, submit = true) => { for (const [k, v] of Object.entries(set || {})) await pg.fill(`#db [name=${k}]`, String(v)); if (submit) { await pg.click('#dfoot button[type=submit]'); await wait(700); } };
  const sum = (l) => Math.round(l.reduce((a, x) => a + x, 0) * 100) / 100;
  const saldo = (i) => ev((id) => T_st(id), i).catch(() => null);
  const st = (pid) => ev((id) => window.__T.C.st[id] || 0, pid);
  const gaveta = () => ev(() => { const c = cxOpen(); return c ? cxRes(c).esp : null; });
  const aberto = (tipo) => ev((t) => Math.round(S.lancamentos.filter((l) => l.tipo === t && !l.pago).reduce((a, l) => a + l.valor, 0) * 100) / 100, tipo);
  const fiadoDe = (cid) => ev((c) => Math.round(S.lancamentos.filter((l) => l.tipo === 'r' && l.cli === c && !l.pago).reduce((a, l) => a + l.valor, 0) * 100) / 100, cid);
  const fluxo = () => ev(() => { const c = caixa(); return Math.round(c.saldo * 100) / 100; });
  const entradasSaidas = () => ev(() => { const E = cashEv().filter((e) => !e.open && e.data <= hoje()); return { ent: Math.round(E.filter((e) => e.v > 0).reduce((a, e) => a + e.v, 0) * 100) / 100, sai: Math.round(-E.filter((e) => e.v < 0).reduce((a, e) => a + e.v, 0) * 100) / 100 }; });
  const bipar = async (q, ean) => { await pg.fill('#pdv-bar', `${q}*${ean}`); await pg.press('#pdv-bar', 'Enter'); await wait(250); };
  async function vender(itens, pag, o = {}) {
    for (const [q, e] of itens) await bipar(q, e);
    if (o.cli) await pg.selectOption('#pdv-cli', o.cli);
    await pg.click(`[data-act=pdvPag][data-id="${pag}"]`); await wait(150);
    if (o.rec) { await pg.fill('#pdv-rec', String(o.rec)); await wait(150); }
    await pg.click('[data-act=pdvFim]'); await wait(700);
  }
  const tentar100 = async (pid) => {
    const nv = await ev(() => S.vendas.length);
    await bipar(100, EAN[0]);
    const aviso = await pg.locator('#toast, .toast').first().innerText().catch(() => '');
    await pg.click('[data-act=pdvPag][data-id="Pix"]'); await wait(150);
    await pg.click('[data-act=pdvFim]'); await wait(600);
    const dlg = await pg.locator('dialog[aria-label="Autorização do administrador"]').innerText().catch(() => '');
    await pg.click('#exno').catch(() => {}); await wait(400);
    const depois = { vendas: (await ev(() => S.vendas.length)) - nv, saldo: await st(pid), carrinho: await ev(() => CART.reduce((a, i) => a + i.q, 0)) };
    await ev(() => { A.pdvLimpar(); }); await wait(200);
    return { aviso, dlg, depois };
  };
  await pg.goto(URL + '/#painel'); await wait(400);

  /* ---------- DIA 1: cadastros, compra, nota ---------- */
  console.log('\n== Dia 1');
  const ids = await ev(([pre, eans]) => {
    const f = { id: 'f' + uid(), nome: pre ? 'Atacado Modelo' : 'Atacado Teste', cnpj: '', contato: '', tel: '', email: '', prazo: 3, cond: '', parc: '30', itens: [], cods: {} }; S.fornecedores.push(f);
    const cli = { id: 'k' + uid(), nome: pre ? 'João Teste' : 'Maria Teste', tel: '', doc: '', end: '', limite: 0, prazo: 30, obs: '' }; S.clientes.push(cli);
    const defs = [['Arroz 5 kg', 22, 29.9, 5], ['Feijão 1 kg', 6.5, 9.9, 10], ['Detergente 500 ml', 1.8, 2.99, 12], ['Caderno 96 folhas', 8, 14.9, 3]];
    const ps = defs.map((d, i) => { const p = { id: 'p' + uid(), cod: 'R' + (i + 1), nome: pre + d[0], cat: 'Teste', custo: d[1], preco: d[2], min: d[3], fid: f.id, ean: eans[i] }; S.produtos.push(p); return p.id; });
    mark('cadastros'); return { f: f.id, cli: cli.id, ps };
  }, [PRE, EAN]);
  await wait(900);
  const sd1 = await Promise.all(ids.ps.map(st));
  ok('1. saldos iniciais 0 nos 4 produtos', sd1.every((x) => x === 0), sd1);
  const dup = await ev((e) => { const n = S.produtos.length; return n; });
  // pedido de compra nº 1
  const kid = await ev(([f, ps]) => { const n = ++S.seq.compra; const id = 'c' + uid(); S.compras.push({ id, n, data: hoje(), fid: f, prev: hoje(), status: 'pendente', receb: '', obs: '', it: [[ps[0], 20, 22], [ps[1], 40, 6.5], [ps[2], 48, 1.8], [ps[3], 10, 8]] }); mark('compras', 'cadastros'); return id; }, [ids.f, ids.ps]);
  await wait(900);
  const totPed = await ev((id) => { const c = S.compras.find((x) => x.id === id); return Math.round(c.it.reduce((a, i) => a + i[1] * i[2], 0) * 100) / 100; }, kid);
  ok('2. total do pedido nº 1 = R$ 866,40', near(totPed, 866.4), totPed);
  ok('2. estoque ainda 0 e nenhuma conta a pagar (pedido pendente)', (await Promise.all(ids.ps.map(st))).every((x) => x === 0) && (await aberto('d')) === 0);
  await ev((id) => receber(id), kid); await wait(300);
  ok('3. janela de recebimento abriu com prazo 30 do fornecedor', (await pg.inputValue('#db [name=dias]')) === '30');
  await pg.click('#dfoot button[type=submit]'); await wait(900);
  const sd3 = await Promise.all(ids.ps.map(st));
  ok('3. estoque: Arroz 20, Feijão 40, Detergente 48, Caderno 10', sd3.join() === '20,40,48,10', sd3);
  ok('3. conta a pagar R$ 866,40 em aberto', near(await aberto('d'), 866.4), await aberto('d'));
  // nota XML
  const xml = path.join(DIR, 'exemplos', 'NFe-exemplo-4521.xml');
  await pg.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 8000 }).catch(() => {});
  for (let t = 0; t < 4 && !(await pg.locator('#dlg[open] input[type=file]').count()); t++) { await wait(1200); await ev(() => fNotaXml()); await wait(500); }
  await pg.setInputFiles('#db input[type=file]', xml); await wait(900);
  const formNota = await pg.locator('#db').innerText();
  const xmlTela = await pg.evaluate(() => ({ n: (document.querySelector('#db [name=numero],#db [name=num],#db [name=n]') || {}).value, itens: document.querySelectorAll('#db .ni').length }));
  ok('4. XML lido: nota 4521 e 5 itens na tela de conferência', xmlTela.n === '4521' && xmlTela.itens === 5, xmlTela);
  await pg.click('#dfoot button[type=submit]'); await wait(1200);
  const nProd = await ev(() => S.produtos.length), nNotas = await ev(() => S.notas.length);
  ok('4. nota gravada e 5 produtos novos criados (4 + 5 = 9)', nNotas === 1 && nProd === 9, [nNotas, nProd]);
  const novos = await ev(() => S.produtos.filter((p) => /^RC-/.test(p.cod)).map((p) => [p.cod, p.nome, C.st[p.id] || 0, p.custo, p.preco]));
  ok('4. estoque das 5 novas: água 240, refri 60, suco 36, cerveja 25, coco 24', novos.map((x) => x[2]).join() === '240,60,36,25,24', novos);
  ok('4. custo da água 0,90 e preço inicial = custo × 1,5', near(novos[0][3], 0.9) && near(novos[0][4], 1.35), novos[0]);
  const parc = await ev(() => S.lancamentos.filter((l) => /^nota:/.test(l.origem)).map((l) => [l.valor, l.venc, l.pago]));
  ok('4. duas parcelas de R$ 960,00 em aberto: 21/12/2026 e 18/01/2027', parc.length === 2 && parc.every((p) => near(p[0], 960) && !p[2]) && parc.map((p) => p[1]).join() === '2026-12-21,2027-01-18', parc);
  ok('4. contas a pagar em aberto = R$ 2.786,40', near(await aberto('d'), 2786.4), await aberto('d'));
  ok('4. os 4 produtos do roteiro não mudaram', (await Promise.all(ids.ps.map(st))).join() === '20,40,48,10');
  ok('4. fluxo realizado ainda R$ 0,00 (nenhuma saída paga)', near(await fluxo(), 0), await fluxo());

  /* ---------- DIA 2: caixa e vendas ---------- */
  console.log('\n== Dia 2');
  await pg.goto(URL + '/#caixa'); await wait(600);
  await pg.fill('#cx-ini', '100'); await pg.click('[data-act=cxAbrir]'); await wait(700);
  ok('5. gaveta R$ 100,00', near(await gaveta(), 100), await gaveta());
  await vender([[2, EAN[0]], [3, EAN[1]]], 'Pix');
  ok('6. venda 1 Pix R$ 89,50; estoque Arroz 18, Feijão 37; gaveta R$ 100,00', near(await ev(() => vTotal(S.vendas.at(-1))), 89.5) && (await st(ids.ps[0])) === 18 && (await st(ids.ps[1])) === 37 && near(await gaveta(), 100));
  let e1 = await entradasSaidas(); ok('6. fluxo: entrada de R$ 89,50', near(e1.ent, 89.5), e1);
  await vender([[4, EAN[2]], [1, EAN[3]]], 'Dinheiro', { rec: 30 });
  const v2 = await ev(() => { const v = S.vendas.at(-1); return { tot: vTotal(v), tr: v.tr }; });
  ok('7. venda 2 dinheiro R$ 26,86, troco R$ 3,14', near(v2.tot, 26.86) && near(v2.tr || 0, 3.14), v2);
  ok('7. estoque Detergente 44, Caderno 9; gaveta R$ 126,86', (await st(ids.ps[2])) === 44 && (await st(ids.ps[3])) === 9 && near(await gaveta(), 126.86), [await st(ids.ps[2]), await gaveta()]);
  e1 = await entradasSaidas(); ok('7. fluxo: entradas R$ 116,36 (89,50 + 26,86)', near(e1.ent, 116.36), e1);
  await vender([[1, EAN[0]], [5, EAN[1]]], 'Fiado / a prazo', { cli: ids.cli });
  ok('8. venda 3 fiado R$ 79,40; Arroz 17, Feijão 32; fiado do cliente R$ 79,40', near(await ev(() => vTotal(S.vendas.at(-1))), 79.4) && (await st(ids.ps[0])) === 17 && (await st(ids.ps[1])) === 32 && near(await fiadoDe(ids.cli), 79.4), [await fiadoDe(ids.cli)]);
  ok('8. gaveta continua R$ 126,86 e fluxo sem entrada nova (fiado é previsto)', near(await gaveta(), 126.86) && near((await entradasSaidas()).ent, 116.36));
  const r9 = await ev(() => { const r = cxRes(cxOpen()); return { tot: r.tot, esp: r.esp }; });
  ok('9. vendido no dia R$ 195,76; gaveta esperada R$ 126,86', near(r9.tot, 195.76) && near(r9.esp, 126.86), r9);
  await ev(() => A.cxFechar()); await wait(300);
  await pg.fill('#db [name=cont]', '126.86'); await wait(200);
  ok('9. tela do fechamento diz que o caixa bateu', /bateu/i.test(await pg.locator('#cx-dif').innerText()));
  await pg.click('#dfoot button[type=submit]'); await wait(900);
  ok('9. caixa fechado sem quebra ou sobra lançada', (await ev(() => S.caixas.at(-1).fechado)) && (await ev(() => S.lancamentos.filter((l) => /de caixa/.test(l.desc || '')).length)) === 0);

  /* ---------- DIA 3: recebimento parcial, estoque na tela em modo aviso ---------- */
  console.log('\n== Dia 3');
  await pg.goto(URL + '/#caixa'); await wait(500);
  await pg.fill('#cx-ini', '126.86'); await pg.click('[data-act=cxAbrir]'); await wait(700);
  await ev((c) => cliPag(c), ids.cli); await wait(300);
  await pg.fill('#db [name=v]', '30'); await pg.selectOption('#db [name=forma]', 'Pix'); await pg.click('#dfoot button[type=submit]'); await wait(900);
  ok('10. recebeu R$ 30,00 por Pix; fiado R$ 49,40; gaveta R$ 126,86', near(await fiadoDe(ids.cli), 49.4) && near(await gaveta(), 126.86), [await fiadoDe(ids.cli), await gaveta()]);
  e1 = await entradasSaidas(); ok('10. fluxo: entradas R$ 146,36 (116,36 + 30,00)', near(e1.ent, 146.36), e1);
  const t3 = await tentar100(ids.ps[0]);
  ok('11. modo aviso, tela: avisa "Só há 17" e pede autorização de administrador ao finalizar', /Só há 17/.test(t3.aviso) && /Estoque insuficiente/.test(t3.dlg) && /disponível 17, pedido 100/.test(t3.dlg), t3);
  ok('11. venda cancelada na autorização: nenhuma venda gravada, saldo do Arroz 17 (sem tocar nos saldos do roteiro)', t3.depois.vendas === 0 && t3.depois.saldo === 17, t3.depois);

  /* ---------- DIA 4 ---------- */
  console.log('\n== Dia 4');
  await vender([[15, EAN[0]]], 'Dinheiro', { rec: 450 });
  ok('12. venda 15 Arroz em dinheiro R$ 448,50; Arroz 2 (abaixo do mínimo 5)', near(await ev(() => vTotal(S.vendas.at(-1))), 448.5) && (await st(ids.ps[0])) === 2, [await st(ids.ps[0])]);
  ok('12. gaveta R$ 575,36', near(await gaveta(), 575.36), await gaveta());
  e1 = await entradasSaidas(); ok('12. fluxo: entradas R$ 594,86', near(e1.ent, 594.86), e1);
  await ev((p) => { S.movimentos.push({ id: 'm' + uid(), data: hoje(), pid: p, tipo: 'e', qtd: 10, motivo: 'Ajuste', obs: '' }); mark('movimentos'); }, ids.ps[0]); await wait(800);
  ok('13. entrada avulsa de 10: Arroz 12; financeiro sem mudança', (await st(ids.ps[0])) === 12 && near((await entradasSaidas()).ent, 594.86));

  /* ---------- DIA 5 ---------- */
  console.log('\n== Dia 5');
  const f0 = await fluxo();
  await ev((c) => cliPag(c), ids.cli); await wait(300);
  await pg.fill('#db [name=v]', '49.40'); await pg.selectOption('#db [name=forma]', 'Dinheiro'); await pg.click('#dfoot button[type=submit]'); await wait(900);
  ok('14. fiado quitado (R$ 0,00)', near(await fiadoDe(ids.cli), 0));
  ok('14. gaveta esperada continua R$ 575,36 (fiado não soma na gaveta)', near(await gaveta(), 575.36), await gaveta());
  e1 = await entradasSaidas();
  const f1 = await fluxo();
  ok('14. fluxo: uma entrada de R$ 49,40 (entradas R$ 644,26)', near(e1.ent, 644.26) && near(f1 - f0, 49.4), [e1, f1 - f0]);
  await ev(() => A.cxMov('sup')); await wait(300);
  await pg.fill('#db [name=v]', '49.40'); await pg.click('#dfoot button[type=submit]'); await wait(800);
  ok('15. suprimento R$ 49,40: gaveta esperada R$ 624,76', near(await gaveta(), 624.76), await gaveta());
  const e2 = await entradasSaidas(); const f2 = await fluxo();
  ok('15. fluxo financeiro NÃO soma o suprimento (continua uma só entrada de R$ 49,40)', near(e2.ent, 644.26) && near(f2, f1), [e2, f2, f1]);
  const idPed = await ev(() => S.lancamentos.find((l) => l.tipo === 'd' && /^compra:/.test(l.origem)).id);
  await ev((i) => pagar(i), idPed); await wait(300);
  await pg.selectOption('#db [name=forma]', 'Transferência'); await pg.click('#dfoot button[type=submit]'); await wait(900);
  ok('16. pedido nº 1 pago; restam as duas parcelas da nota (R$ 1.920,00) em aberto', near(await aberto('d'), 1920), await aberto('d'));
  e1 = await entradasSaidas(); ok('16. fluxo: saídas R$ 866,40', near(e1.sai, 866.4), e1);

  /* ---------- DIA 6 ---------- */
  console.log('\n== Dia 6');
  await ev(() => { const h = hoje(); S.lancamentos.push({ id: 'l' + uid(), tipo: 'd', cat: 'Outros', desc: 'Material de limpeza', parte: '', valor: 50, data: h, venc: h, pago: h, vpago: 50, forma: 'Dinheiro', origem: '', parc: '' }, { id: 'l' + uid(), tipo: 'r', cat: 'Outros', desc: 'Receita avulsa', parte: '', valor: 20, data: h, venc: h, pago: h, vpago: 20, forma: 'Pix', origem: '', parc: '' }); mark('lancamentos'); }); await wait(800);
  e1 = await entradasSaidas(); ok('17. fluxo: entradas R$ 664,26 e saídas R$ 916,40', near(e1.ent, 664.26) && near(e1.sai, 916.4), e1);
  // liga o bloqueio
  if (CEN === 'basico') {
    const p2 = await ctx.newPage(); await p2.goto(URL + '/estoque-conferencia'); await p2.waitForTimeout(1200);
    await p2.check('#conf'); await p2.click('[data-m=bloqueio]'); await p2.waitForTimeout(1200);
    ok('18. a administradora liga o bloqueio pela Conferência de estoque', /Bloqueando/.test(await p2.locator('#status').innerText()));
    await p2.close();
  } else {
    const adm = await b.newContext(); const ap = await adm.newPage();
    const cod = await ap.request.post(URL + '/api/login', { data: { usuario: ADM[0], senha: ADM[1] } });
    const mr = await ap.request.post(URL + '/api/estoque/modo', { data: { modo: 'bloqueio', confirmo: true } });
    ok('18. administradora da empresa liga o bloqueio (a TI-Lidiane não tem essa ação sem concessão)', cod.ok() && mr.ok());
    const tiNeg = await pg.evaluate(async () => (await fetch('/api/estoque/modo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modo: 'off' }) })).status);
    ok('18. TI-Lidiane sem concessão: mudar o modo de estoque negado (403)', tiNeg === 403, tiNeg);
    await adm.close();
  }
  await pg.goto(URL + '/#caixa'); await wait(600);
  const t6 = await tentar100(ids.ps[0]);
  ok('18. modo bloqueio, tela: avisa "Só há 12" e pede autorização de administrador ao finalizar', /Só há 12/.test(t6.aviso) && /disponível 12, pedido 100/.test(t6.dlg), t6);
  ok('19. venda cancelada: nenhuma venda gravada; saldo do Arroz continua 12', t6.depois.vendas === 0 && t6.depois.saldo === 12, t6.depois);

  /* ---------- DIA 7 ---------- */
  console.log('\n== Dia 7');
  await ev(() => A.cxFechar()); await wait(300);
  await pg.fill('#db [name=cont]', '624.76'); await pg.click('#dfoot button[type=submit]'); await wait(900);
  ok('20. caixa do Dia 3 fechado contando R$ 624,76: diferença R$ 0,00 e nenhuma quebra lançada', near(await ev(() => S.caixas.at(-1).dif || 0), 0) && (await ev(() => S.lancamentos.filter((l) => /de caixa/.test(l.desc || '')).length)) === 0);
  await pg.goto(URL + '/#caixa'); await wait(500);
  await pg.fill('#cx-ini', '100'); await pg.click('[data-act=cxAbrir]'); await wait(700);
  await ev(() => A.cxFechar()); await wait(300);
  await pg.fill('#db [name=cont]', '99'); await wait(200);
  ok('21. tela diz "Faltam R$ 1,00"', /Faltam.*1,00/.test(await pg.locator('#cx-dif').innerText()), await pg.locator('#cx-dif').innerText());
  await pg.click('#dfoot button[type=submit]'); await wait(900);
  const q = await ev(() => S.lancamentos.find((l) => /Quebra de caixa/.test(l.desc || '')));
  ok('21. despesa "Quebra de caixa" de R$ 1,00 já paga', q && near(q.valor, 1) && q.pago, q);
  const estFin = await Promise.all([...ids.ps, ...(await ev(() => S.produtos.filter((p) => /^RC-/.test(p.cod)).map((p) => p.id)))].map(st));
  ok('22. estoque final: 12, 32, 44, 9 + 240, 60, 36, 25, 24', estFin.join() === '12,32,44,9,240,60,36,25,24', estFin);
  const rel = await pg.evaluate(async () => (await (await fetch('/api/estoque/relatorio')).json()));
  const dv = rel.linhas ? rel.linhas.filter((l) => l.divergencias && l.divergencias.length).length : 'sem acesso';
  ok('22. conferência de estoque do servidor sem divergências', dv === 0, dv);
  ok('22. fiado aberto total R$ 0,00', near(await ev(() => S.lancamentos.filter((l) => l.tipo === 'r' && l.cli && !l.pago).reduce((a, l) => a + l.valor, 0)), 0));
  const vend = await ev(() => Math.round(S.vendas.reduce((a, v) => a + vTotal(v), 0) * 100) / 100);
  ok('23. vendido na semana R$ 644,26', near(vend, 644.26), vend);
  const fim = await entradasSaidas(); const fx = await fluxo();
  ok('24. fluxo realizado: entradas R$ 664,26, saídas R$ 917,40, saldo −R$ 253,14', near(fim.ent, 664.26) && near(fim.sai, 917.4) && near(fx, -253.14), [fim, fx]);
  ok('24. em aberto: a pagar R$ 1.920,00; a receber R$ 0,00', near(await aberto('d'), 1920) && near(await aberto('r'), 0), [await aberto('d'), await aberto('r')]);

  /* ---------- persistência: recarrega a tela e confere no servidor ---------- */
  await wait(1500); await pg.reload(); await wait(2000);
  const re = await ev(() => ({ fl: Math.round(caixa().saldo * 100) / 100, ab: Math.round(S.lancamentos.filter((l) => l.tipo === 'd' && !l.pago).reduce((a, l) => a + l.valor, 0) * 100) / 100, nv: S.vendas.length, nl: S.lancamentos.length }));
  ok('depois de recarregar a tela, os mesmos números vêm do servidor (fluxo −253,14; a pagar 1.920,00; 4 vendas)', near(re.fl, -253.14) && near(re.ab, 1920) && re.nv === 4, re);

  /* ---------- Histórico e telas por plano ---------- */
  console.log('\n== Acesso por menu e URL');
  await pg.goto(URL + '/#financeiro'); await wait(800);
  const fintxt = await pg.locator('#app, main, body').first().innerText();
  const temDre = /Resultado\s*·/.test(fintxt), temLucro = /Lucro líquido ·/.test(fintxt);
  const temAP = /A pagar em aberto/.test(fintxt), temCx = /Saldo em caixa hoje/.test(fintxt);
  if (CEN === 'basico') ok('Básico: card Resultado e KPI de lucro líquido ocultos; contas e caixa continuam', !temDre && !temLucro && temAP && temCx, { temDre, temLucro, temAP, temCx });
  else ok('Completo: card Resultado visível para a TI-Lidiane', temDre && temLucro && temAP && temCx, { temDre, temLucro });
  await pg.goto(URL + '/#painel'); await wait(600);
  const menu = await pg.locator('#snav').innerText();
  ok(`menu ${CEN}: Notas fiscais ${/Notas fiscais/.test(menu) ? 'presente' : 'ausente'}, Análise ${/Análise/.test(menu) ? 'presente' : 'ausente'}, Histórico ${/Histórico de altera/.test(menu) ? 'presente' : 'ausente'}`, /Notas fiscais/.test(menu) && /Histórico de altera/.test(menu) && (CEN === 'basico' ? !/Análise/.test(menu) : /Análise/.test(menu)), menu.replace(/\n/g, ' | ').slice(0, 300));
  const hp = await ctx.newPage(); const rs = await hp.goto(URL + '/historico'); await hp.waitForTimeout(1200);
  const hl = await hp.locator('#linhas tr').count();
  ok('Histórico abre por URL e lista as ações da semana', rs.status() === 200 && hl >= 20, [rs.status(), hl]);
  const htxt = await hp.locator('#linhas').innerText();
  ok('Histórico mostra venda, recebimento de fiado, nota e baixa com o autor', /Venda/.test(htxt) && /Nota fiscal/.test(htxt) && new RegExp(CEN === 'basico' ? 'rose|Rose' : 'TI-Lidiane').test(htxt), htxt.slice(0, 300));
  await hp.close();
  ok('sem erros de página no navegador durante o roteiro', errs.length === 0, errs.slice(0, 3));

  await b.close(); await stop();
  console.log(`\n${CEN}: ${pass} passaram, ${fail} falharam`); if (falhas.length) console.log('Falhas:', falhas);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(); process.exit(1); });
