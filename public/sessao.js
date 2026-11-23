/*
 * Sessão do usuário: busca quem está conectado e o que o perfil dele pode acessar (RBAC).
 * Deixa window.SESSAO disponível e avisa o sistema com o evento "sessao", para o menu lateral
 * mostrar só as telas permitidas e as vendas e os caixas guardarem quem registrou.
 * Fora do servidor da Rose (por exemplo, no claude.ai), não faz nada e tudo fica liberado.
 */
(function () {
  'use strict';
  window.SESSAO_PENDENTE = true; // o sistema espera saber o perfil antes de mostrar as telas
  function pronto() { window.SESSAO_PENDENTE = false; window.dispatchEvent(new Event('sessao')); }
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) { location.replace('/login'); return null; }
      return r.ok ? r.json() : null;
    })
    .then(function (j) {
      if (j && j.user) window.SESSAO = j.user;
      pronto();
    })
    .catch(pronto);
})();
