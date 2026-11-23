/*
 * Adaptador de banco de dados da Rose Mercearia e Bazar.
 *
 * O site foi feito para guardar os dados pelo armazenamento do claude.ai (window.claude.use('db')).
 * Fora do claude.ai, este arquivo oferece a mesma interface, falando com o servidor do projeto
 * (rotas /api/col/...). Assim o index.html continua igual: nenhuma tela ou função muda.
 *
 * Interface atendida (a única que o site usa):
 *   db.collection(nome).onSnapshot(next, error)  → avisa o site quando os dados mudam
 *   db.collection(nome).doc(id).set(objeto)      → grava um documento inteiro
 *   db.collection(nome).doc(id).delete()         → apaga um documento
 *   db.collection(nome).doc(id).get()            → lê um documento
 */
(function () {
  'use strict';
  if (window.claude && typeof window.claude.use === 'function') return; // dentro do claude.ai, usa o original

  var POLL_MS = 4000;
  var SEG = /^[A-Za-z0-9_.~:@+-]{1,200}$/;

  function dbError(code, message) {
    return { code: code, message: message };
  }

  function request(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(
      function (r) {
        if (r.status === 401 || r.status === 403) throw dbError('invalid_argument', 'Sem permissão para gravar.');
        if (r.status === 413) throw dbError('invalid_argument', 'Documento grande demais.');
        if (r.status >= 500) throw dbError('unavailable', 'Servidor indisponível (HTTP ' + r.status + ').');
        if (!r.ok) throw dbError('invalid_argument', 'Pedido recusado (HTTP ' + r.status + ').');
        return r.json();
      },
      function () {
        throw dbError('unavailable', 'Sem conexão com o servidor.');
      }
    );
  }

  var META = { fromCache: false, hasPendingWrites: false };
  function docSnap(id, data) {
    return { id: id, exists: data !== undefined, data: function () { return data; }, metadata: META };
  }

  var collections = {};

  function collection(name) {
    if (!SEG.test(name)) throw new TypeError('Nome de coleção inválido: ' + name);
    if (collections[name]) return collections[name];
    var base = '/api/col/' + encodeURIComponent(name);
    var listeners = [];
    var lastVersion = null;
    var timer = null;
    var busy = false;
    var writeSeq = 0; // sobe a cada gravação: uma leitura que começou antes dela é descartada

    function emit(list) {
      var docs = list.map(function (d) { return docSnap(d.id, d.data); });
      var snap = { docs: docs, size: docs.length, empty: docs.length === 0, metadata: META, docChanges: function () { return []; } };
      listeners.slice().forEach(function (l) { try { l.next(snap); } catch (e) { setTimeout(function () { throw e; }); } });
    }

    function poll(force) {
      if (busy || !listeners.length) return;
      if (!force && document.hidden) return;
      busy = true;
      var seq = writeSeq;
      request('GET', base + '/_version')
        .then(function (v) {
          if (!force && v.version === lastVersion) return;
          return request('GET', base).then(function (all) {
            if (seq !== writeSeq) { lastVersion = null; return; } // dados podem estar velhos
            lastVersion = all.version;
            emit(all.docs);
          });
        })
        .catch(function () { /* falha passageira: tenta de novo no próximo ciclo */ })
        .then(function () { busy = false; });
    }

    function soon() {
      setTimeout(function () { poll(false); }, 300);
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll(false);
    });

    function doc(id) {
      if (!SEG.test(id) || id === '.' || id === '..') throw new TypeError('Nome de documento inválido: ' + id);
      var url = base + '/' + encodeURIComponent(id);
      return {
        id: id,
        path: name + '/' + id,
        get: function () {
          return request('GET', base).then(function (all) {
            var d = all.docs.filter(function (x) { return x.id === id; })[0];
            return docSnap(id, d ? d.data : undefined);
          });
        },
        set: function (data) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) return Promise.reject(dbError('invalid_argument', 'O documento precisa ser um objeto.'));
          writeSeq++;
          return request('PUT', url, data).then(function () { writeSeq++; soon(); });
        },
        update: function (data) {
          return this.get().then(function (s) {
            if (!s.exists) throw dbError('invalid_argument', 'Documento não existe.');
            return request('PUT', url, Object.assign({}, s.data(), data));
          }).then(function () { soon(); });
        },
        delete: function () {
          writeSeq++;
          return request('DELETE', url).then(function () { writeSeq++; soon(); });
        },
      };
    }

    var ref = {
      path: name,
      doc: doc,
      onSnapshot: function (next, error) {
        var l = { next: next, error: error };
        listeners.push(l);
        poll(true);
        if (!timer) timer = setInterval(function () { poll(false); }, POLL_MS);
        return function () {
          listeners = listeners.filter(function (x) { return x !== l; });
          if (!listeners.length && timer) { clearInterval(timer); timer = null; }
        };
      },
    };
    collections[name] = ref;
    return ref;
  }

  var db = Object.freeze({
    collection: collection,
    doc: function (p) {
      var parts = String(p).split('/');
      if (parts.length !== 2) throw new TypeError('Caminho de documento inválido: ' + p);
      return collection(parts[0]).doc(parts[1]);
    },
  });

  window.claude = Object.freeze({
    use: function (name) {
      return Promise.resolve(name === 'db' ? db : null);
    },
  });
})();
