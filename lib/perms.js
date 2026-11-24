'use strict';
/*
 * Permissões (Etapa 2). Tudo que o servidor decide sobre quem pode ler ou gravar o quê está aqui.
 * Permissão efetiva de um usuário = permissões do perfil + concedidas a ele − negadas a ele.
 * Regra geral: o que não está claramente permitido é negado.
 */
const D = require('../public/docdiff.js');

/* ---------- catálogo ---------- */
const CATALOG = [
  ['Telas', [
    ['painel.ver', 'Ver o painel inicial'], ['caixa.ver', 'Ver o caixa'], ['vendas.ver', 'Ver vendas'], ['clientes.ver', 'Ver clientes e fiado'],
    ['produtos.ver', 'Ver produtos'], ['estoque.ver', 'Ver entradas e saídas'], ['notas.ver', 'Ver notas fiscais'], ['compras.ver', 'Ver compras'],
    ['fornecedores.ver', 'Ver fornecedores'], ['financeiro.ver', 'Ver contas, lançamentos, fiado e fluxo de caixa'], ['financeiro.dre', 'Ver a DRE (resultado)'], ['analise.ver', 'Ver análise de produtos'],
  ]],
  ['Caixa e vendas', [
    ['caixa.vender', 'Vender no PDV'], ['caixa.abrir_fechar', 'Abrir e fechar o caixa'], ['caixa.sangria', 'Fazer sangria e suprimento'],
    ['caixa.desconto', 'Dar desconto na venda'], ['vendas.editar', 'Registrar e alterar vendas'], ['vendas.excluir', 'Excluir ou cancelar venda'],
    ['clientes.editar', 'Cadastrar e alterar clientes'], ['clientes.excluir', 'Excluir clientes'], ['fiado.receber', 'Receber pagamentos de fiado'],
  ]],
  ['Produtos e estoque', [
    ['produtos.editar', 'Cadastrar e alterar produtos'], ['produtos.excluir', 'Excluir produtos'], ['produtos.ver_custo', 'Ver custo dos produtos e das compras'],
    ['produtos.ver_margem', 'Ver margem e lucro'], ['estoque.movimentar', 'Registrar entradas, saídas e ajustes'], ['estoque.conferir', 'Ver o relatório de conferência de estoque'],
    ['estoque.excecao', 'Autorizar venda acima do estoque e mudar o modo de proteção'], ['notas.editar', 'Lançar notas fiscais'], ['notas.excluir', 'Excluir notas fiscais'],
  ]],
  ['Compras e fornecedores', [
    ['compras.editar', 'Fazer e alterar pedidos de compra'], ['compras.receber', 'Receber mercadoria'], ['compras.excluir', 'Excluir pedidos'],
    ['fornecedores.editar', 'Cadastrar e alterar fornecedores'], ['fornecedores.excluir', 'Excluir fornecedores'],
  ]],
  ['Financeiro', [
    ['financeiro.lancar', 'Criar lançamentos'], ['financeiro.baixar', 'Dar baixa em contas'], ['financeiro.editar', 'Alterar lançamentos'], ['financeiro.excluir', 'Excluir lançamentos'],
    ['financeiro.solicitar_pagamento', 'Solicitar pagamentos (aprovação na Etapa 4)'],
  ]],
  ['Aprovações (fluxo na Etapa 4)', [
    ['aprovacao.ver', 'Acompanhar aprovações'], ['aprovacao.aprovar', 'Aprovar operações'], ['aprovacao.config', 'Configurar limites e regras de aprovação'],
  ]],
  ['Administração', [
    ['usuarios.gerir', 'Gerenciar usuários e perfis'], ['config.editar', 'Alterar configurações do sistema'], ['backup.copiar', 'Copiar backup'],
    ['backup.restaurar', 'Restaurar backup'], ['dados.apagar', 'Apagar todos os dados'], ['auditoria.ver', 'Ver o histórico de auditoria (Etapa 3)'],
  ]],
];
const ALL = CATALOG.flatMap(([, l]) => l.map(([k]) => k));
const ALLSET = new Set(ALL);
const without = (l) => ALL.filter((k) => !l.includes(k));
const VIEWS = ALL.filter((k) => /\.ver$/.test(k) && !/^(aprovacao|auditoria)/.test(k));

/* ---------- perfis padrão ---------- */
const PRESETS = {
  administrador: { label: 'Administrador', perms: ALL },
  financeiro: {
    label: 'Financeiro',
    perms: ['painel.ver', 'caixa.ver', 'vendas.ver', 'clientes.ver', 'produtos.ver', 'estoque.ver', 'notas.ver', 'compras.ver', 'fornecedores.ver', 'financeiro.ver', 'analise.ver',
      'fiado.receber', 'compras.editar', 'compras.receber', 'fornecedores.editar', 'produtos.ver_custo', 'produtos.ver_margem', 'estoque.conferir',
      'financeiro.lancar', 'financeiro.baixar', 'financeiro.editar', 'financeiro.excluir', 'financeiro.solicitar_pagamento', 'aprovacao.ver'],
  },
  caixa_vendas: {
    label: 'Caixa/Vendas',
    perms: ['caixa.ver', 'vendas.ver', 'clientes.ver', 'caixa.vender', 'caixa.abrir_fechar', 'caixa.sangria', 'caixa.desconto', 'vendas.editar', 'clientes.editar', 'fiado.receber'],
  },
  estoque: {
    label: 'Estoque',
    perms: ['painel.ver', 'produtos.ver', 'estoque.ver', 'notas.ver', 'compras.ver', 'produtos.editar', 'estoque.movimentar', 'estoque.conferir', 'notas.editar', 'compras.receber'],
  },
  compras: {
    label: 'Compras',
    perms: ['painel.ver', 'produtos.ver', 'estoque.ver', 'notas.ver', 'compras.ver', 'fornecedores.ver', 'compras.editar', 'compras.receber', 'fornecedores.editar', 'notas.editar', 'produtos.ver_custo'],
  },
  consulta: { label: 'Consulta/Gerência', perms: [...VIEWS, 'produtos.ver_custo', 'produtos.ver_margem', 'estoque.conferir', 'aprovacao.ver'] },
  // perfis de antes da Etapa 2: continuam funcionando como eram, até a administradora reatribuir cada pessoa
  gerente_atual: { label: 'Gerente (atual)', perms: without(['usuarios.gerir', 'backup.copiar', 'backup.restaurar', 'dados.apagar', 'estoque.excecao', 'estoque.conferir', 'financeiro.solicitar_pagamento', 'aprovacao.ver', 'aprovacao.aprovar', 'aprovacao.config', 'auditoria.ver']) },
  caixa_atual: { label: 'Caixa (atual)', perms: ['caixa.ver', 'vendas.ver', 'clientes.ver', 'caixa.vender', 'caixa.abrir_fechar', 'caixa.sangria', 'caixa.desconto', 'vendas.editar', 'clientes.editar', 'fiado.receber'] },
};
const LEGACY = { admin: 'administrador', gerente: 'gerente_atual', operador: 'gerente_atual', caixa: 'caixa_atual' };
// papel gravado na coluna antiga "role" (a versão anterior do sistema lê só ela; perfis novos caem no mais restrito)
const LEGACY_ROLE = (profileId) => (profileId === 'administrador' ? 'admin' : profileId === 'gerente_atual' ? 'gerente' : 'caixa');

/* ---------- permissão efetiva ---------- */
function effective(profile, user) {
  const base = new Set((profile && profile.perms) || []);
  for (const p of (user && user.perm_grant) || []) if (ALLSET.has(p)) base.add(p);
  for (const p of (user && user.perm_deny) || []) base.delete(p);
  return base;
}
const TABMAP = [['painel', 'painel.ver'], ['caixa', 'caixa.ver'], ['vendas', 'vendas.ver'], ['clientes', 'clientes.ver'], ['produtos', 'produtos.ver'], ['movimentacoes', 'estoque.ver'],
  ['notas', 'notas.ver'], ['compras', 'compras.ver'], ['fornecedores', 'fornecedores.ver'], ['financeiro', 'financeiro.ver'], ['analise', 'analise.ver']];
const tabsOf = (set) => TABMAP.filter(([, p]) => set.has(p)).map(([t]) => t);

/* ---------- escrita: que permissão cada mudança exige ---------- */
// devolve grupos; cada grupo é uma lista "qualquer uma serve"; todos os grupos precisam ser atendidos. null = negado a todos exceto administrador.
const ADMIN_ONLY = [['*admin']];
const prefix = (s) => (typeof s === 'string' ? s.split(':')[0] : '');
const isNew = (o) => o.before === null || o.before === undefined;

function needOp(docId, o) {
  const del = o.op === 'del' || o.op === 'list';
  if (docId === 'cadastros') {
    if (o.k === 'clientes') return [[del ? 'clientes.excluir' : 'clientes.editar']];
    if (o.k === 'produtos') return [[del ? 'produtos.excluir' : 'produtos.editar']];
    if (o.k === 'fornecedores') return [[del ? 'fornecedores.excluir' : 'fornecedores.editar']];
    if (o.k === 'config') return [['config.editar']];
    return ADMIN_ONLY;
  }
  if (docId === 'caixas') {
    if (del) return [['vendas.excluir']];
    const g = [['caixa.abrir_fechar', 'caixa.vender', 'caixa.sangria']];
    const nb = ((o.before && o.before.mov) || []).length, na = ((o.after && o.after.mov) || []).length;
    if (na > nb) g.push(['caixa.sangria']);
    return g;
  }
  if (/^vendas-\d{4}-\d{2}$/.test(docId)) {
    if (del) return [['vendas.excluir']];
    const g = [['caixa.vender', 'vendas.editar']];
    if ((+(o.after && o.after.desc) || 0) > (+(o.before && o.before.desc) || 0)) g.push(['caixa.desconto']);
    return g;
  }
  if (docId === 'compras') {
    if (del) return [['compras.excluir']];
    if (o.before && o.after && o.before.status !== 'recebido' && o.after.status === 'recebido') return [['compras.receber', 'compras.editar']];
    return [['compras.editar']];
  }
  if (/^notas-\d{4}-\d{2}$/.test(docId)) return [[del ? 'notas.excluir' : 'notas.editar']];
  if (docId === 'movimentos') return [['estoque.movimentar']];
  if (docId === 'lancamentos') {
    const rec = o.after || o.before || {}, pre = prefix(rec.origem);
    if (del) return [pre === 'venda' ? ['financeiro.excluir', 'vendas.excluir'] : ['financeiro.excluir']];
    if (isNew(o)) {
      if (pre === 'venda') return [['caixa.vender', 'vendas.editar', 'fiado.receber', 'financeiro.lancar']];
      if (pre === 'compra' || pre === 'nota') return [['compras.receber', 'compras.editar', 'notas.editar', 'financeiro.lancar']];
      if (!rec.origem && rec.cat === 'Outros' && /de caixa/.test(rec.desc || '')) return [['caixa.abrir_fechar', 'financeiro.lancar']];
      return [['financeiro.lancar']];
    }
    const b = o.before, a = o.after, g = [];
    const baixa = !b.pago && a.pago;
    const mudou = Object.keys(Object.assign({}, a, b)).some((k) => !['pago', 'vpago', 'forma', 'cli'].includes(k) && !D.eq(a[k], b[k]));
    if (baixa || a.pago !== b.pago || a.vpago !== b.vpago || a.forma !== b.forma) g.push(b.tipo === 'r' && (pre === 'venda' || b.cli) ? ['fiado.receber', 'financeiro.baixar'] : ['financeiro.baixar']);
    if (mudou) g.push(['financeiro.editar']);
    return g.length ? g : [['financeiro.editar']];
  }
  return ADMIN_ONLY;
}

const has = (set, p) => set.has(p);
const okGroups = (set, groups, isAdminSet) => groups.every((g) => g.some((p) => (p === '*admin' ? isAdminSet : has(set, p))));

// ops: { docId: [op...] }. Devolve null se tudo permitido, ou uma mensagem.
function checkWrite(set, docsOps) {
  const adminSet = set.has('usuarios.gerir') && set.has('dados.apagar');
  for (const docId of Object.keys(docsOps)) {
    const ops = docsOps[docId] || [];
    for (const o of ops) {
      if (!o || o.k === 'seq' || o.k === 'saldos') continue;
      const groups = needOp(docId, o);
      if (!okGroups(set, groups, adminSet)) return `Seu perfil não tem permissão para esta alteração (${docId}${o.k && o.k !== 'items' ? ' · ' + o.k : ''}).`;
    }
  }
  return null;
}

/* ---------- leitura: o que cada usuário recebe ---------- */
const anyOf = (set, l) => l.some((p) => set.has(p));
const PROD_READ = ['produtos.ver', 'caixa.vender', 'vendas.ver', 'estoque.ver', 'compras.ver', 'notas.ver', 'financeiro.ver', 'analise.ver'];
const CLI_READ = ['clientes.ver', 'caixa.vender', 'vendas.ver', 'fiado.receber', 'financeiro.ver'];
const FOR_READ = ['fornecedores.ver', 'compras.ver', 'notas.ver', 'financeiro.ver'];
const VENDA_READ = ['vendas.ver', 'caixa.vender', 'financeiro.ver', 'analise.ver'];

// remove a posição idx de cada item sem mexer nas seguintes: troca por 0 (mantém o formato)
const zeroAt = (it, idx) => (Array.isArray(it) ? it.map((i) => { if (!Array.isArray(i) || i.length <= idx) return i; const c = i.slice(); c[idx] = 0; return c; }) : it);
const mapIt = (doc, idx) => (doc && Array.isArray(doc.items) ? { ...doc, items: doc.items.map((r) => (r && r.it ? { ...r, it: zeroAt(r.it, idx) } : r)) } : doc);

// campos escondidos de acordo com as permissões; usados na leitura e na gravação (para não perder o que o usuário não vê)
function hiddenSpec(set) {
  const custo = set.has('produtos.ver_custo'), margem = custo && set.has('produtos.ver_margem');
  return { custo, margem };
}

function filterDoc(docId, data, set, extra) {
  const h = hiddenSpec(set);
  if (data === null || data === undefined) return data;
  if (docId === 'cadastros') {
    const d = { ...data };
    if (!anyOf(set, CLI_READ)) d.clientes = [];
    if (!anyOf(set, FOR_READ)) d.fornecedores = [];
    if (!anyOf(set, PROD_READ)) d.produtos = [];
    else if (!h.custo) d.produtos = (d.produtos || []).map((p) => { const { custo, ...r } = p; return r; });
    if (!set.has('financeiro.ver') && d.config) { const { saldoIni, saldoData, ...c } = d.config; d.config = c; }
    if (extra && extra.saldos) d.saldos = extra.saldos;
    return d;
  }
  if (docId === 'caixas') return anyOf(set, ['caixa.ver', 'caixa.vender', 'vendas.ver', 'financeiro.ver']) ? data : { items: [] };
  if (/^vendas-/.test(docId)) {
    if (!anyOf(set, VENDA_READ)) return { items: [] };
    return h.margem ? data : mapIt(data, 3);
  }
  if (docId === 'compras') {
    if (!anyOf(set, ['compras.ver', 'financeiro.ver', 'compras.receber'])) return { items: [] };
    return h.custo ? data : mapIt(data, 2);
  }
  if (/^notas-/.test(docId)) {
    if (!anyOf(set, ['notas.ver', 'financeiro.ver'])) return { items: [] };
    if (h.custo) return data;
    const m = mapIt(data, 2);
    return { ...m, items: (m.items || []).map((n) => ({ ...n, total: 0 })) };
  }
  if (docId === 'movimentos') return anyOf(set, ['estoque.ver', 'financeiro.ver', 'analise.ver']) ? data : { items: [] };
  if (docId === 'lancamentos') {
    if (set.has('financeiro.ver')) return data;
    if (!anyOf(set, ['fiado.receber', 'vendas.ver', 'caixa.vender'])) return { items: [] };
    return { ...data, items: (data.items || []).filter((l) => l && l.tipo === 'r' && (prefix(l.origem) === 'venda' || l.cli)) };
  }
  return set.has('usuarios.gerir') ? data : { items: [] };
}

// o usuário não vê alguns campos: ao gravar, o servidor devolve os campos escondidos do registro atual
// (a tela dele nem sabe que existem, e não pode alterá-los).
function mergeHidden(docId, ops, curDoc, set) {
  const h = hiddenSpec(set);
  const find = (L, id) => ((curDoc && curDoc[L]) || []).find((r) => String(r.id) === String(id));
  const view = (rec) => (rec ? filterDoc(docId, docId === 'cadastros' ? { produtos: [rec], config: {} } : { items: [rec] }, set) : null);
  for (const o of ops) {
    if (!o || (o.op !== 'put' && o.op !== 'del')) continue;
    const hide = (docId === 'cadastros' && o.k === 'produtos' && !h.custo) || (/^vendas-/.test(docId) && !h.margem) || (docId === 'compras' && !h.custo) || (/^notas-/.test(docId) && !h.custo);
    if (!hide) continue;
    const L = docId === 'cadastros' ? o.k : 'items';
    const cur = find(L, o.id);
    if (!cur) continue;
    const vcur = docId === 'cadastros' ? view(cur).produtos[0] : view(cur).items[0];
    if (o.before && D.eq(vcur, o.before)) {
      o.before = D.clone(cur);
      if (o.op === 'put' && o.after) {
        if (docId === 'cadastros') o.after = { ...o.after, ...(cur.custo !== undefined ? { custo: cur.custo } : {}) };
        else if (Array.isArray(cur.it) && Array.isArray(o.after.it)) {
          const idx = /^vendas-/.test(docId) ? 3 : 2;
          o.after.it = o.after.it.map((i, n) => { const c = cur.it[n]; if (Array.isArray(i) && Array.isArray(c) && c.length > idx && i.length > idx && String(i[0]) === String(c[0])) { const k = i.slice(); k[idx] = c[idx]; return k; } return i; });
          if (/^notas-/.test(docId) && cur.total !== undefined) o.after.total = cur.total;
        }
      }
    }
  }
  return ops;
}

module.exports = { CATALOG, ALL, PRESETS, LEGACY, LEGACY_ROLE, effective, tabsOf, checkWrite, filterDoc, mergeHidden, hiddenSpec, needOp, okGroups, prefix };

// quem não lê todos os documentos de estoque recebe o saldo pronto do servidor (cadastros.saldos)
module.exports.needsSaldos = (set) => !(anyOf(set, VENDA_READ) && anyOf(set, ['estoque.ver', 'financeiro.ver', 'analise.ver']) && anyOf(set, ['compras.ver', 'financeiro.ver', 'compras.receber']) && anyOf(set, ['notas.ver', 'financeiro.ver'])) && anyOf(set, PROD_READ);
