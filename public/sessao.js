/*
 * Sessão do usuário: busca quem está conectado e mostra o nome, "Usuários" (administradora) e "Sair" no topo.
 * Também deixa window.SESSAO disponível para o sistema registrar quem fez cada venda e cada caixa.
 * Fora do servidor da Rose (por exemplo, no claude.ai), não faz nada.
 */
(function () {
  'use strict';
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) { location.replace('/login'); return null; }
      return r.ok ? r.json() : null;
    })
    .then(function (j) {
      if (!j || !j.user) return;
      window.SESSAO = j.user;
      function put() {
        var tb = document.querySelector('.top .tb');
        if (!tb || document.getElementById('who')) return;
        var s = document.createElement('span');
        s.id = 'who';
        s.className = 'who';
        var b = document.createElement('b');
        b.textContent = j.user.name;
        s.appendChild(b);
        if (j.user.role === 'admin') {
          var a = document.createElement('a');
          a.href = '/usuarios';
          a.textContent = 'Usuários';
          s.appendChild(document.createTextNode(' · '));
          s.appendChild(a);
        }
        var o = document.createElement('a');
        o.href = '/sair';
        o.textContent = 'Sair';
        s.appendChild(document.createTextNode(' · '));
        s.appendChild(o);
        var per = tb.querySelector('.perw');
        tb.insertBefore(s, per || null);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put();
    })
    .catch(function () {});
})();
