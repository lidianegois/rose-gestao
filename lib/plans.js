'use strict';
/*
 * Plano da empresa (piloto do plano Básico). O plano é o TETO do que qualquer pessoa da empresa pode ter:
 * permissão efetiva = (perfil + concedidas − negadas) ∩ teto do plano, inclusive para a administradora.
 * Sem a configuração "plano" o sistema se comporta como antes (completo). PLANO_ENFORCE=off volta a esse comportamento.
 */
const P = require('./perms.js');

const FORA_DO_BASICO = ['analise.ver', 'financeiro.solicitar_pagamento', 'aprovacao.ver', 'aprovacao.aprovar', 'aprovacao.config', 'backup.restaurar', 'dados.apagar'];
/* no Básico estas só valem para a administradora da empresa, mesmo que alguém as receba por concessão ou perfil personalizado */
const SO_ADMINISTRADORA = ['auditoria.ver', 'notas.excluir', 'estoque.excecao', 'usuarios.gerir', 'config.editar', 'backup.copiar'];
/* perfis de uso interno (suporte): não valem em planos de empresa */
const PERFIS_INTERNOS = ['ti_lidiane'];
/* ações sensíveis do perfil interno: só por concessão individual */
const SENSIVEIS_TI = ['dados.apagar', 'backup.restaurar', 'usuarios.gerir', 'estoque.excecao', 'config.editar', 'aprovacao.aprovar', 'aprovacao.config'];

const PLANOS = {
  basico: { label: 'Básico', fora: new Set(FORA_DO_BASICO), soAdm: new Set(SO_ADMINISTRADORA), internos: false },
  completo: { label: 'Completo', fora: new Set(), soAdm: new Set(), internos: true },
};
const nome = (p) => (PLANOS[p] ? p : 'completo');

const TI_LIDIANE = { id: 'ti_lidiane', label: 'TI-Lidiane', perms: P.ALL.filter((k) => !SENSIVEIS_TI.includes(k)), system: true };

/* devolve o conjunto de permissões depois do plano. `profileId` é o perfil da pessoa; `user` traz as negações individuais. */
function limit(planId, profileId, set, user) {
  const plano = PLANOS[nome(planId)];
  const out = new Set(set);
  // a DRE acompanha financeiro.ver (compatível com perfis gravados antes da permissão existir); pode ser negada por pessoa
  if (out.has('financeiro.ver') && !((user && user.perm_deny) || []).includes('financeiro.dre')) out.add('financeiro.dre');
  if (!plano.internos && PERFIS_INTERNOS.includes(profileId)) return new Set();
  for (const k of plano.fora) out.delete(k);
  if (profileId !== 'administrador') for (const k of plano.soAdm) out.delete(k);
  return out;
}

module.exports = { PLANOS, nome, limit, TI_LIDIANE, PERFIS_INTERNOS, SENSIVEIS_TI, FORA_DO_BASICO, SO_ADMINISTRADORA };
