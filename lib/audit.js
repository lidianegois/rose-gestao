'use strict';
/*
 * Histórico de alterações (Etapa 3, parte A).
 * Transforma "o documento era assim e ficou assim" em linhas legíveis: quem, quando, o quê, antes e depois.
 * Roda dentro da mesma transação da gravação: se o histórico falhar, a gravação não acontece (nada muda sem rastro).
 * Interruptor de emergência: AUDIT_LOG=off (só para quem precisa desligar com urgência; as linhas já gravadas não são afetadas).
 */
const crypto = require('crypto');
const D = require('../public/docdiff.js');

const ENABLED = () => process.env.AUDIT_LOG !== 'off';
const MAX_SNAP = 200 * 1024; // acima disso guarda só o tamanho e a impressão digital, não o conteúdo

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function snap(v) {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  if (s.length > MAX_SNAP) return { _grande: true, bytes: s.length, sha256: sha(s) };
  return JSON.parse(s);
}
const changedKeys = (a, b) => {
  const o = [];
  const ka = Object.assign({}, a, b);
  Object.keys(ka).forEach((k) => { if (!D.eq(a && a[k], b && b[k])) o.push(k); });
  return o;
};
const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');

/* nome legível do registro, só para a frase de resumo */
function label(docId, lista, rec) {
  const r = rec || {};
  if (/^vendas-/.test(docId)) return 'Venda nº ' + (r.n !== undefined ? r.n : r.id);
  if (/^notas-/.test(docId)) return 'Nota fiscal nº ' + (r.num || r.id);
  if (docId === 'compras') return 'Pedido de compra nº ' + (r.n !== undefined ? r.n : r.id);
  if (docId === 'lancamentos') return (r.tipo === 'r' ? 'Conta a receber' : 'Conta a pagar') + ': ' + (r.desc || r.cat || r.id) + (r.valor !== undefined ? ' (' + brl(r.valor) + ')' : '');
  if (docId === 'caixas') return 'Caixa de ' + (r.data || r.id);
  if (docId === 'movimentos') return 'Movimento de estoque' + (r.motivo ? ' (' + r.motivo + ')' : '');
  if (docId === 'cadastros') {
    if (lista === 'produtos') return 'Produto ' + (r.nome || r.id);
    if (lista === 'clientes') return 'Cliente ' + (r.nome || r.id);
    if (lista === 'fornecedores') return 'Fornecedor ' + (r.nome || r.id);
  }
  return (lista || docId) + ' ' + (r.id !== undefined ? r.id : '');
}
const VERBO = { criar: 'criado', alterar: 'alterado', excluir: 'excluído' };

/* linhas do histórico para um documento que mudou de "before" para "after" */
function rowsForDoc(actor, docId, before, after) {
  const base = { user_id: (actor && actor.id) || null, user_name: (actor && actor.name) || 'Sistema', perfil: (actor && actor.perfil) || null, alvo: docId };
  const rows = [];
  for (const o of D.diffDoc(docId, before, after)) {
    if (o.op === 'put') {
      const acao = o.before === null ? 'criar' : 'alterar';
      const campos = acao === 'alterar' ? changedKeys(o.before, o.after) : undefined;
      rows.push({ ...base, acao, lista: o.k, registro: String(o.id), resumo: label(docId, o.k, o.after) + ' ' + VERBO[acao], antes: snap(o.before), depois: snap(o.after), detalhe: campos ? { campos } : null });
    } else if (o.op === 'del') {
      rows.push({ ...base, acao: 'excluir', lista: o.k, registro: String(o.id), resumo: label(docId, o.k, o.before) + ' excluído', antes: snap(o.before), depois: null, detalhe: null });
    } else if (o.op === 'list') {
      const b = Array.isArray(o.before) ? o.before : [], a = Array.isArray(o.after) ? o.after : [];
      rows.push({ ...base, acao: 'lista', lista: o.k, registro: null, resumo: 'Lista ' + o.k + ' de ' + docId + ' substituída (' + b.length + ' → ' + a.length + ' registros)', antes: null, depois: null,
        detalhe: { antes: { n: b.length, sha256: sha(JSON.stringify(b)) }, depois: { n: a.length, sha256: sha(JSON.stringify(a)) } } });
    } else { // field | value: configurações
      const nome = o.op === 'field' ? o.k + '.' + o.key : o.k;
      rows.push({ ...base, acao: 'config', lista: o.k, registro: nome, resumo: 'Configuração ' + nome + ' alterada', antes: snap(o.bAbs ? null : o.before), depois: snap(o.aAbs ? null : o.after), detalhe: null });
    }
  }
  return rows;
}

/* documento inteiro apagado de uma vez (administradora): guarda como ele era */
function rowForDocDeleted(actor, docId, before) {
  const s = JSON.stringify(before === undefined ? null : before);
  return { user_id: (actor && actor.id) || null, user_name: (actor && actor.name) || 'Sistema', perfil: (actor && actor.perfil) || null, acao: 'apagar_documento', alvo: docId, lista: null, registro: null,
    resumo: 'Documento ' + docId + ' apagado', antes: snap(before), depois: null, detalhe: { bytes: s.length, sha256: sha(s) } };
}

/* evento administrativo (usuários, perfis, configurações). Nunca recebe senhas nem hashes. */
function event(actor, acao, alvo, registro, resumo, antes, depois, detalhe) {
  return { user_id: (actor && actor.id) || null, user_name: (actor && actor.name) || 'Sistema', perfil: (actor && actor.perfil) || null, acao, alvo, lista: null, registro: registro === undefined ? null : String(registro),
    resumo, antes: snap(antes), depois: snap(depois), detalhe: detalhe || null };
}

const COLS = ['user_id', 'user_name', 'perfil', 'acao', 'alvo', 'lista', 'registro', 'resumo', 'antes', 'depois', 'detalhe'];
const JSONC = new Set(['antes', 'depois', 'detalhe']);
/* grava em blocos para não passar do limite de parâmetros do PostgreSQL */
async function insertRows(q, rows) {
  const CH = 100;
  for (let i = 0; i < rows.length; i += CH) {
    const part = rows.slice(i, i + CH), vals = [], ph = [];
    part.forEach((r, j) => {
      ph.push('(' + COLS.map((c, k) => '$' + (j * COLS.length + k + 1) + (JSONC.has(c) ? '::jsonb' : '')).join(',') + ')');
      COLS.forEach((c) => vals.push(JSONC.has(c) ? (r[c] === null || r[c] === undefined ? null : JSON.stringify(r[c])) : (r[c] === undefined ? null : r[c])));
    });
    await q.query('INSERT INTO audit_log (' + COLS.join(',') + ') VALUES ' + ph.join(','), vals);
  }
}

module.exports = { ENABLED, rowsForDoc, rowForDocDeleted, event, insertRows, COLS, label };
