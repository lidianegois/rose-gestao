'use strict';
/*
 * Roda dentro da transação de cada gravação, com os documentos do lote já travados:
 *  1) confere as permissões do usuário sobre cada mudança (negado por padrão);
 *  2) devolve campos que ele não enxerga (custo, margem) para não serem apagados por uma tela que não os conhece;
 *  3) completa o custo das vendas novas feitas por quem não vê custo;
 *  4) protege o estoque: trava por produto, confere o saldo depois da mudança e avisa ou bloqueia.
 */
const P = require('./perms.js');
const STK = require('./stock.js');

function makeGuard({ set, user, settings, excecao, skipStock }) {
  const modo = (settings && settings.estoque_modo) || 'aviso';
  return async function guard(api) {
    const ops = api.ops;
    const deny = P.checkWrite(set, ops);
    if (deny) return { abort: { code: 'permissao', message: deny } };

    for (const id of Object.keys(ops)) P.mergeHidden(id, ops[id], api.cur[id], set);

    // apagar tudo (administradora) é decisão consciente: não passa pela proteção de estoque
    const wipe = skipStock || (set.has('dados.apagar') && Object.values(ops).every((l) => l.every((o) => o.op === 'del' || o.op === 'list')));
    const touchesStock = !wipe && Object.keys(ops).some((id) => STK.STOCK_DOC(id) && ops[id].length);
    const hide = P.hiddenSpec(set);
    const newSales = !hide.margem && Object.keys(ops).some((id) => /^vendas-/.test(id) && ops[id].some((o) => o.op === 'put' && !o.before));
    if (!touchesStock && !newSales) return {};

    const pids = STK.touched(ops);
    if (touchesStock && modo !== 'off' && pids.length) await api.lock(pids);
    const docs = await api.read();
    for (const id of Object.keys(api.cur)) if (STK.STOCK_DOC(id)) docs[id] = api.cur[id] || {};
    const produtos = (docs.cadastros && docs.cadastros.produtos) || [];

    if (newSales) {
      const custo = {};
      produtos.forEach((p) => { custo[p.id] = +p.custo || 0; });
      for (const id of Object.keys(ops)) {
        if (!/^vendas-/.test(id)) continue;
        for (const o of ops[id]) if (o.op === 'put' && !o.before && o.after && Array.isArray(o.after.it)) {
          o.after.it = o.after.it.map((i) => { if (!Array.isArray(i)) return i; const c = i.slice(); c[3] = custo[i[0]] || 0; return c; });
        }
      }
    }

    if (!touchesStock || modo === 'off') return { ops };
    const viol = STK.check(docs, ops, produtos);
    if (!viol.length) return { ops };
    const base = (kind, v, extra) => ({ kind, product_id: v.pid, product_name: v.nome, saldo: v.saldo, qty: v.consumo, user_id: user && user.id, user_name: user && user.name, ...extra });
    if (excecao) return { ops, logs: viol.map((v) => base('excecao', v, { authorized_by: excecao.nome, justification: excecao.justificativa })) };
    if (modo === 'aviso') return { ops, logs: viol.map((v) => base('aviso', v)) };
    return { abort: { code: 'estoque', message: 'Estoque insuficiente.', itens: viol }, logsAbort: viol.map((v) => base('bloqueio', v)) };
  };
}

module.exports = { makeGuard };
