'use strict';
/*
 * Estoque no servidor. A fórmula é a mesma da tela (public/index.html, moves() e ctx()):
 *   saldo = entradas manuais − saídas manuais − itens vendidos + compras recebidas (sem NF) + notas fiscais
 * A proteção olha o saldo antes e depois de um lote: só barra o que consome e deixa o saldo abaixo de zero.
 */
const D = require('../public/docdiff.js');

const num = (x) => (+x || 0);
function saldos(docs, produtos) {
  const st = {};
  (produtos || []).forEach((p) => { st[p.id] = 0; });
  const add = (pid, q) => { if (pid in st) st[pid] += q; };
  for (const id of Object.keys(docs)) {
    const items = (docs[id] && docs[id].items) || [];
    if (id === 'movimentos') for (const m of items) add(m.pid, m.tipo === 'e' ? num(m.qtd) : -num(m.qtd));
    else if (/^vendas-/.test(id)) for (const v of items) for (const i of v.it || []) add(i[0], -num(i[1]));
    else if (id === 'compras') for (const c of items) { if (c.status === 'recebido' && !c.viaNF) for (const i of c.it || []) add(i[0], num(i[1])); }
    else if (/^notas-/.test(id)) for (const n of items) for (const i of n.it || []) add(i[0], num(i[1]));
  }
  return st;
}
const STOCK_DOC = (id) => id === 'movimentos' || id === 'compras' || /^(vendas|notas)-\d{4}-\d{2}$/.test(id);

// produtos tocados pelas mudanças (antes e depois)
function touched(docsOps) {
  const s = new Set();
  const fromRec = (r) => {
    if (!r) return;
    if (r.pid) s.add(String(r.pid));
    for (const i of r.it || []) if (Array.isArray(i)) s.add(String(i[0]));
  };
  for (const id of Object.keys(docsOps)) if (STOCK_DOC(id)) for (const o of docsOps[id] || []) { fromRec(o.before); fromRec(o.after); }
  return [...s].sort();
}

// confere o lote. docs: documentos de estoque já lidos (os do lote entram com o conteúdo travado)
function check(docs, docsOps, produtos) {
  const before = saldos(docs, produtos);
  const next = {};
  for (const id of Object.keys(docs)) next[id] = docs[id];
  for (const id of Object.keys(docsOps)) {
    if (!STOCK_DOC(id)) continue;
    next[id] = D.applyOps(id, docs[id] || {}, docsOps[id], { force: true }).doc;
  }
  const after = saldos(next, produtos);
  const names = {};
  (produtos || []).forEach((p) => { names[p.id] = p.nome; });
  const out = [];
  for (const pid of Object.keys(after)) {
    if (after[pid] < before[pid] - 1e-9 && after[pid] < -1e-9) {
      out.push({ pid, nome: names[pid] || pid, saldo: before[pid], consumo: before[pid] - after[pid], ficaria: after[pid] });
    }
  }
  return out;
}

// relatório de conferência: o que seria bloqueado e as divergências encontradas
function report(docs, produtos) {
  const st = saldos(docs, produtos);
  const ent = {}, sai = {}, vend = {}, desconhecidos = new Set();
  const known = new Set((produtos || []).map((p) => p.id));
  const seen = (pid) => { if (!known.has(pid)) desconhecidos.add(pid); };
  for (const id of Object.keys(docs)) {
    const items = (docs[id] && docs[id].items) || [];
    if (id === 'movimentos') for (const m of items) { seen(m.pid); (m.tipo === 'e' ? ent : sai)[m.pid] = num((m.tipo === 'e' ? ent : sai)[m.pid]) + num(m.qtd); }
    else if (/^vendas-/.test(id)) for (const v of items) for (const i of v.it || []) { seen(i[0]); vend[i[0]] = num(vend[i[0]]) + num(i[1]); }
    else if (id === 'compras') for (const c of items) { if (c.status === 'recebido' && !c.viaNF) for (const i of c.it || []) { seen(i[0]); ent[i[0]] = num(ent[i[0]]) + num(i[1]); } }
    else if (/^notas-/.test(id)) for (const n of items) for (const i of n.it || []) { seen(i[0]); ent[i[0]] = num(ent[i[0]]) + num(i[1]); }
  }
  const linhas = (produtos || []).map((p) => {
    const saldo = st[p.id] || 0, e = num(ent[p.id]), s = num(sai[p.id]), v = num(vend[p.id]);
    const div = [];
    if (saldo < 0) div.push('saldo negativo: saiu mais do que entrou');
    if (e === 0 && (v > 0 || s > 0)) div.push('há saídas ou vendas, mas nenhuma entrada registrada');
    return { id: p.id, cod: p.cod || '', nome: p.nome, saldo, entradas: e, saidas: s, vendidos: v, minimo: num(p.min), bloqueada: saldo <= 0, divergencias: div };
  });
  return { linhas, produtosDesconhecidos: [...desconhecidos] };
}

module.exports = { saldos, check, report, touched, STOCK_DOC };
