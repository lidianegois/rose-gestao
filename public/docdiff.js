/*
 * Comparação e aplicação de mudanças por registro (usada pelo servidor e pelo navegador).
 *
 * Os dados do site são documentos JSON com listas de registros (cada um com "id"). Em vez de
 * regravar o documento inteiro (e apagar o que outra pessoa acabou de salvar), o navegador envia
 * só as mudanças: "este registro era assim e agora é assim". O servidor aplica cada mudança
 * somente se o registro ainda estiver como o navegador o conhecia; senão, avisa o conflito.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoseDiff = factory();
})(this, function () {
  'use strict';

  var LISTS = function (id) { return id === 'cadastros' ? ['clientes', 'produtos', 'fornecedores'] : ['items']; };
  var SKIP = { seq: true }; // a numeração é do servidor

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function stable(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function eq(a, b) { return stable(a) === stable(b); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function omit(o, keys) { var c = {}; Object.keys(o || {}).forEach(function (k) { if (keys.indexOf(k) < 0) c[k] = o[k]; }); return c; }

  // lista "com id": todos os registros são objetos com id e não há id repetido
  function idsOk(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!isObj(r) || (typeof r.id !== 'string' && typeof r.id !== 'number')) return false;
      var k = String(r.id);
      if (seen[k]) return false;
      seen[k] = 1;
    }
    return true;
  }

  function diffDoc(id, base, next) {
    base = isObj(base) ? base : {};
    next = isObj(next) ? next : {};
    var ops = [], lists = LISTS(id);
    lists.forEach(function (L) {
      var b = Array.isArray(base[L]) ? base[L] : [], n = Array.isArray(next[L]) ? next[L] : [];
      if (!(idsOk(b) && idsOk(n))) { if (!eq(b, n)) ops.push({ k: L, op: 'list', before: clone(b), after: clone(n) }); return; }
      var bm = {}, nm = {};
      b.forEach(function (r) { bm[String(r.id)] = r; });
      n.forEach(function (r) {
        var key = String(r.id); nm[key] = r;
        if (!(key in bm)) ops.push({ k: L, op: 'put', id: key, before: null, after: clone(r) });
        else if (!eq(bm[key], r)) ops.push({ k: L, op: 'put', id: key, before: clone(bm[key]), after: clone(r) });
      });
      b.forEach(function (r) { var key = String(r.id); if (!(key in nm)) ops.push({ k: L, op: 'del', id: key, before: clone(r) }); });
    });
    var keys = {};
    Object.keys(base).concat(Object.keys(next)).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (K) {
      if (lists.indexOf(K) >= 0 || SKIP[K]) return;
      var bv = base[K], nv = next[K];
      if (isObj(bv) || isObj(nv)) {
        var bo = isObj(bv) ? bv : {}, no = isObj(nv) ? nv : {}, subs = {};
        Object.keys(bo).concat(Object.keys(no)).forEach(function (s) { subs[s] = 1; });
        Object.keys(subs).forEach(function (s) {
          if (eq(bo[s], no[s]) && ((s in bo) === (s in no))) return;
          ops.push({ k: K, op: 'field', key: s, before: clone(bo[s]), bAbs: !(s in bo), after: clone(no[s]), aAbs: !(s in no) });
        });
      } else if (!eq(bv, nv) || ((K in base) !== (K in next))) {
        ops.push({ k: K, op: 'value', before: clone(bv), bAbs: !(K in base), after: clone(nv), aAbs: !(K in next) });
      }
    });
    return ops;
  }

  // aplica as mudanças sobre "cur". Devolve {doc, conflicts, changed}.
  // opt.force: aplica sem conferir o "antes" (usado para atualizar a cópia local depois de gravar)
  // opt.ignore: campos que não contam ao comparar registros iguais (ex.: "n", renumerado pelo servidor)
  function applyOps(id, cur, ops, opt) {
    opt = opt || {};
    var ign = opt.ignore || [];
    var doc = isObj(cur) ? clone(cur) : {}, conflicts = [], lists = LISTS(id), st = {};
    function conflict(o, why, current) { conflicts.push({ doc: id, k: o.k, id: o.id, key: o.key, reason: why, current: clone(current) }); }
    function listState(L) {
      if (st[L]) return st[L];
      if (!Array.isArray(doc[L])) doc[L] = [];
      var arr = doc[L];
      st[L] = { arr: arr, ok: idsOk(arr) };
      return st[L];
    }
    function indexOf(s, key) { for (var i = 0; i < s.arr.length; i++) if (String(s.arr[i].id) === key) return i; return -1; }
    (ops || []).forEach(function (o) {
      if (!o || SKIP[o.k]) return;
      if (lists.indexOf(o.k) >= 0) {
        var s = listState(o.k);
        if (o.op === 'list') {
          if (opt.force || eq(s.arr, o.before)) { doc[o.k] = clone(o.after); st[o.k] = null; }
          else if (!eq(s.arr, o.after)) conflict(o, 'lista alterada por outra pessoa', s.arr);
          return;
        }
        if (!s.ok) { conflict(o, 'lista sem identificação', s.arr); return; }
        var i = indexOf(s, o.id), cur1 = i >= 0 ? s.arr[i] : null;
        if (o.op === 'put') {
          if (o.before === null) {
            if (!cur1) { s.arr.push(clone(o.after)); }
            else if (eq(omit(cur1, ign), omit(o.after, ign)) || opt.force) { if (opt.force) s.arr[i] = clone(o.after); }
            else conflict(o, 'já existe um registro com este código', cur1);
          } else if (!cur1) { if (opt.force) s.arr.push(clone(o.after)); else conflict(o, 'registro apagado por outra pessoa', null); }
          else if (opt.force || eq(cur1, o.before)) s.arr[i] = clone(o.after);
          else if (eq(cur1, o.after)) { /* já está assim */ }
          else conflict(o, 'registro alterado por outra pessoa', cur1);
        } else if (o.op === 'del') {
          if (!cur1) return;
          if (opt.force || eq(cur1, o.before)) s.arr.splice(i, 1);
          else conflict(o, 'registro alterado por outra pessoa', cur1);
        }
        return;
      }
      if (o.op === 'field') {
        var base = isObj(doc[o.k]) ? doc[o.k] : (doc[o.k] = {});
        var has = o.key in base, curv = base[o.key];
        var sameBefore = (has === !o.bAbs) && (!has || eq(curv, o.before)), sameAfter = (has === !o.aAbs) && (!has || eq(curv, o.after));
        if (opt.force || sameBefore) { if (o.aAbs) delete base[o.key]; else base[o.key] = clone(o.after); }
        else if (!sameAfter) conflict(o, 'configuração alterada por outra pessoa', curv);
      } else if (o.op === 'value') {
        var h2 = o.k in doc, cv = doc[o.k];
        var sb = (h2 === !o.bAbs) && (!h2 || eq(cv, o.before)), sa = (h2 === !o.aAbs) && (!h2 || eq(cv, o.after));
        if (opt.force || sb) { if (o.aAbs) delete doc[o.k]; else doc[o.k] = clone(o.after); }
        else if (!sa) conflict(o, 'valor alterado por outra pessoa', cv);
      }
    });
    return { doc: doc, conflicts: conflicts, changed: !eq(doc, isObj(cur) ? cur : {}) };
  }

  // a descrição de lançamentos criados por uma venda cita o número dela: acompanha o número definitivo
  function renumDesc(desc, n) { return typeof desc === 'string' ? desc.replace(/^(Venda nº )\d+/, '$1' + n) : desc; }

  return { renumDesc: renumDesc, diffDoc: diffDoc, applyOps: applyOps, eq: eq, stable: stable, clone: clone, omit: omit, LISTS: LISTS };
});
