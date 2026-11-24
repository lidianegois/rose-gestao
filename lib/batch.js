'use strict';
/*
 * Regras de um lote de mudanças, independentes do banco (valem para PostgreSQL e para o arquivo local):
 * confere conflitos registro a registro e dá o número definitivo às vendas e compras novas.
 */
const D = require('../public/docdiff.js');

const COUNTERS = [[/^vendas-\d{4}-\d{2}$/, 'venda'], [/^compras$/, 'compra']];
const counterOf = (id) => { for (const [re, n] of COUNTERS) if (re.test(id)) return n; return null; };
const COUNTER_NAMES = ['venda', 'compra'];

/*
 * cur:      { id: dadoAtual | null }   documentos já travados na transação
 * counters: { venda, compra }          valores atuais dos contadores
 * docsOps:  { id: ops | (dadoAtual) => ops }
 * opts.bulk: importação/restauração: mantém os números e só empurra o contador para cima
 */
function plan(cur, counters, docsOps, opts) {
  opts = opts || {};
  const out = { updates: {}, counters: { ...counters }, assigned: {}, conflicts: [] };
  const ids = Object.keys(docsOps).sort();
  const opsOf = {};
  // 1) números definitivos das vendas e compras novas
  for (const id of ids) {
    const doc = cur[id] || {};
    let ops = typeof docsOps[id] === 'function' ? docsOps[id](cur[id] || null) : docsOps[id];
    ops = D.clone((ops || []).filter((o) => o && o.k !== 'seq'));
    opsOf[id] = ops;
    const cname = counterOf(id);
    if (!cname) continue;
    const have = new Map((Array.isArray(doc.items) ? doc.items : []).map((r) => [String(r.id), r]));
    for (const o of ops) {
      if (o.k !== 'items' || o.op !== 'put' || o.before !== null) continue;
      const ex = have.get(String(o.id));
      if (ex && D.eq(D.omit(ex, ['n']), D.omit(o.after, ['n']))) { // repetição de um pedido já gravado
        o.after.n = ex.n;
        (out.assigned[id] = out.assigned[id] || {})[o.id] = ex.n;
        continue;
      }
      if (opts.bulk) {
        const n = Math.floor(+o.after.n) || 0;
        if (n > out.counters[cname]) out.counters[cname] = n;
        continue;
      }
      const n = ++out.counters[cname];
      o.after.n = n;
      (out.assigned[id] = out.assigned[id] || {})[o.id] = n;
    }
  }
  // 2) lançamentos criados pela mesma venda citam o número definitivo
  const vendaN = {};
  for (const id of Object.keys(out.assigned)) if (counterOf(id) === 'venda') Object.assign(vendaN, out.assigned[id]);
  for (const id of ids) {
    for (const o of opsOf[id]) {
      if (id !== 'lancamentos' || o.op !== 'put' || !o.after || typeof o.after.origem !== 'string') continue;
      const m = /^venda:(.+)$/.exec(o.after.origem);
      if (m && vendaN[m[1]] !== undefined && o.before === null) o.after.desc = D.renumDesc(o.after.desc, vendaN[m[1]]);
    }
  }
  // 3) aplica, conferindo conflitos
  for (const id of ids) {
    const r = D.applyOps(id, cur[id] || {}, opsOf[id], { ignore: ['n', 'desc'] });
    if (r.conflicts.length) { out.conflicts.push(...r.conflicts); continue; }
    if (r.changed) out.updates[id] = r.doc;
  }
  return out;
}

const needsCounters = (ids) => ids.some((id) => counterOf(id));

module.exports = { plan, counterOf, needsCounters, COUNTER_NAMES };
