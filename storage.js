'use strict';
/*
 * Armazenamento dos documentos do site.
 * - PostgreSQL (produção): tabela app_docs, uma linha por documento, conteúdo em JSONB.
 * - Arquivo JSON (só desenvolvimento local, quando não há DATABASE_URL).
 * "version" é um contador que sobe a cada gravação: o site consulta esse número
 * a cada poucos segundos e só baixa tudo de novo quando ele muda.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./public/docdiff.js');
const B = require('./lib/batch.js');
const P = require('./lib/perms.js');
const STK = require('./lib/stock.js');

function createStore() {
  return process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(path.join(__dirname, 'data'));
}

function pgStore(url) {
  const { Pool } = require('pg');
  // O "sslmode" escrito no endereço passaria por cima da opção ssl abaixo e pode recusar o certificado
  // de provedores como Supabase e Neon. Por isso ele é tirado do endereço e o SSL é ligado aqui.
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode');
  ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].forEach((k) => u.searchParams.delete(k));
  const useSsl = process.env.PGSSL === 'true' || (sslmode && sslmode !== 'disable');
  const pool = new Pool({ connectionString: u.toString(), ssl: useSsl ? { rejectUnauthorized: false } : false, max: 5 });
  return {
    kind: 'PostgreSQL',
    async init() {
      await runMigrations(pool);
      for (const [id, p] of Object.entries(P.PRESETS)) {
        await pool.query('INSERT INTO app_roles (id, label, perms, system) VALUES ($1,$2,$3::jsonb,true) ON CONFLICT (id) DO NOTHING', [id, p.label, JSON.stringify(p.perms)]);
      }
    },
    async roles() {
      return (await pool.query('SELECT id, label, perms, system FROM app_roles ORDER BY system DESC, label')).rows;
    },
    async saveRole(r) {
      await pool.query('INSERT INTO app_roles (id, label, perms, system) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (id) DO UPDATE SET label=$2, perms=$3::jsonb, updated_at=now()', [r.id, r.label, JSON.stringify(r.perms), !!r.system]);
    },
    async settings() {
      const o = {};
      (await pool.query('SELECT key, value FROM app_settings')).rows.forEach((x) => { o[x.key] = x.value; });
      return o;
    },
    async setSetting(k, v) {
      await pool.query('INSERT INTO app_settings (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=now()', [k, JSON.stringify(v)]);
    },
    async stockLog(entries) { await insertLog(pool, entries); },
    async stockLogList(limit) {
      return (await pool.query('SELECT id, at, kind, product_id, product_name, saldo, qty, user_name, authorized_by, justification FROM app_stock_log ORDER BY id DESC LIMIT $1', [limit || 500])).rows;
    },
    // todos os documentos da coleção que contam para o estoque, sem travar (para relatório)
    async stockDocs(col) {
      const r = await pool.query("SELECT id, data FROM app_docs WHERE col = $1 AND (id IN ('movimentos','compras','cadastros') OR id ~ '^(vendas|notas)-[0-9]{4}-[0-9]{2}$')", [col]);
      const o = {};
      r.rows.forEach((x) => { o[x.id] = x.data; });
      return o;
    },
    async list(col) {
      const [r, c] = await Promise.all([
        pool.query('SELECT id, data, rev FROM app_docs WHERE col = $1 ORDER BY id', [col]),
        pool.query('SELECT name, value FROM app_counters'),
      ]);
      const ctr = {};
      c.rows.forEach((x) => { ctr[x.name] = Number(x.value); });
      return r.rows.map((x) => ({ id: x.id, rev: Number(x.rev), data: x.id === 'cadastros' ? withSeq(x.data, ctr) : x.data }));
    },
    async applyBatch(col, docsOps, opts) {
      const ids = Object.keys(docsOps).sort();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '15s'");
        const created = new Set();
        for (const id of ids) {
          const ins = await c.query("INSERT INTO app_docs (col, id, data) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (col, id) DO NOTHING RETURNING id", [col, id]);
          if (ins.rows.length) created.add(id);
        }
        const rows = await c.query('SELECT id, data FROM app_docs WHERE col = $1 AND id = ANY($2) ORDER BY id FOR UPDATE', [col, ids]);
        const cur = {};
        rows.rows.forEach((x) => { cur[x.id] = created.has(x.id) ? null : x.data; });
        let counters = { venda: 0, compra: 0 };
        if (B.needsCounters(ids)) {
          await c.query("INSERT INTO app_counters (name, value) VALUES ('venda', 0), ('compra', 0) ON CONFLICT (name) DO NOTHING");
          const cr = await c.query("SELECT name, value FROM app_counters WHERE name IN ('venda', 'compra') ORDER BY name FOR UPDATE");
          cr.rows.forEach((x) => { counters[x.name] = Number(x.value); });
        }
        let ops = docsOps, logs = [];
        if (opts && opts.guard) {
          ops = resolveOps(docsOps, cur);
          const g = await opts.guard({
            cur, ops,
            lock: async (keys) => { for (const k of [...keys].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estoque:' + k]); },
            read: async () => {
              const r = await c.query("SELECT id, data FROM app_docs WHERE col = $1 AND (id IN ('movimentos','compras','cadastros') OR id ~ '^(vendas|notas)-[0-9]{4}-[0-9]{2}$')", [col]);
              const o = {};
              r.rows.forEach((x) => { o[x.id] = x.data; });
              return o;
            },
          });
          if (g && g.abort) { await c.query('ROLLBACK'); if (g.logsAbort && g.logsAbort.length) { try { await insertLog(c, g.logsAbort); } catch (e) { /* registro é auxiliar */ } } return { ok: false, abort: g.abort }; }
          if (g && g.ops) ops = g.ops;
          if (g && g.logs) logs = g.logs;
        }
        const pl = B.plan(cur, counters, ops, opts);
        if (pl.conflicts.length) { await c.query('ROLLBACK'); return { ok: false, conflicts: pl.conflicts }; }
        if (logs.length) await insertLog(c, logs);
        for (const id of ids) {
          if (pl.updates[id]) {
            await c.query('UPDATE app_docs SET data = $3::jsonb, rev = rev + 1, updated_at = now() WHERE col = $1 AND id = $2', [col, id, JSON.stringify(pl.updates[id])]);
          } else if (created.has(id)) {
            await c.query('DELETE FROM app_docs WHERE col = $1 AND id = $2', [col, id]);
          }
        }
        for (const n of B.COUNTER_NAMES) {
          if (pl.counters[n] !== counters[n]) await c.query('UPDATE app_counters SET value = $2, updated_at = now() WHERE name = $1', [n, pl.counters[n]]);
        }
        let version = null;
        if (Object.keys(pl.updates).length) {
          const v = await c.query("SELECT nextval('app_docs_rev') AS v");
          version = String(v.rows[0].v);
        }
        await c.query('COMMIT');
        return { ok: true, version, assigned: pl.assigned, changed: Object.keys(pl.updates) };
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (x) { /* conexão já encerrada */ }
        throw e;
      } finally {
        c.release();
      }
    },
    async version() {
      const r = await pool.query('SELECT last_value, is_called FROM app_docs_rev');
      return String(r.rows[0].is_called ? r.rows[0].last_value : 0);
    },
    async put(col, id, data) {
      // gravação do documento inteiro (clientes antigos): vira um lote com as diferenças em relação ao que está salvo
      const r = await this.applyBatch(col, { [id]: (cur) => D.diffDoc(id, cur, data) }, {});
      return r.version || (await this.version());
    },
    async users() {
      const r = await pool.query('SELECT id, username, name, pass, role, role_id, perm_grant, perm_deny, active, pwv, created_at, last_login FROM app_users ORDER BY created_at');
      return r.rows;
    },
    async createUser(u) {
      await pool.query('INSERT INTO app_users (id, username, name, pass, role, active, pwv, role_id, perm_grant, perm_deny) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)', [u.id, u.username, u.name, u.pass, u.role, u.active, u.pwv, u.role_id || null, JSON.stringify(u.perm_grant || []), JSON.stringify(u.perm_deny || [])]);
    },
    async updateUser(id, f) {
      const keys = Object.keys(f).filter((k) => ['name', 'pass', 'role', 'active', 'pwv', 'last_login', 'role_id', 'perm_grant', 'perm_deny'].includes(k));
      if (!keys.length) return;
      const js = (k) => k === 'perm_grant' || k === 'perm_deny';
      const sets = keys.map((k, i) => `${k} = $${i + 2}${js(k) ? '::jsonb' : ''}`).join(', ');
      await pool.query(`UPDATE app_users SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => (js(k) ? JSON.stringify(f[k] || []) : f[k]))]);
    },
    async remove(col, id) {
      await pool.query('DELETE FROM app_docs WHERE col = $1 AND id = $2', [col, id]);
      const r = await pool.query("SELECT nextval('app_docs_rev') AS v");
      return String(r.rows[0].v);
    },
    close() {
      return pool.end();
    },
  };
}

function fileStore(dir) {
  const file = path.join(dir, 'banco-local.json');
  let state = { rev: 0, cols: {} };
  let queue = Promise.resolve();
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };
  const serial = (fn) => (queue = queue.then(fn, fn));
  return {
    kind: 'arquivo local (data/banco-local.json)',
    async init() {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.revs = state.revs || {};
      if (!state.counters) {
        const all = state.cols.loja || {};
        const mx = (f) => Math.max(0, ...Object.keys(all).filter(f).flatMap((id) => (all[id].items || []).map((r) => +r.n || 0)));
        const sq = (all.cadastros && all.cadastros.seq) || {};
        state.counters = { venda: Math.max(+sq.venda || 0, mx((id) => id.startsWith('vendas-'))), compra: Math.max(+sq.compra || 0, mx((id) => id === 'compras')) };
        save();
      }
    },
    async list(col) {
      const docs = state.cols[col] || {};
      return Object.keys(docs).sort().map((id) => ({ id, rev: (state.revs[col + '/' + id]) || 1, data: id === 'cadastros' ? withSeq(docs[id], state.counters) : docs[id] }));
    },
    applyBatch(col, docsOps, opts) {
      return serial(async () => {
        const docs = (state.cols[col] = state.cols[col] || {});
        const ids = Object.keys(docsOps).sort();
        const cur = {};
        ids.forEach((id) => { cur[id] = docs[id] === undefined ? null : D.clone(docs[id]); });
        let ops = docsOps, logs = [];
        if (opts && opts.guard) {
          ops = resolveOps(docsOps, cur);
          const g = await opts.guard({
            cur, ops, lock: async () => {},
            read: async () => {
              const o = {};
              Object.keys(docs).filter((id) => STK.STOCK_DOC(id) || id === 'cadastros').forEach((id) => { o[id] = D.clone(docs[id]); });
              return o;
            },
          });
          if (g && g.abort) { if (g.logsAbort && g.logsAbort.length) { this.stockLogSync(g.logsAbort); } return { ok: false, abort: g.abort }; }
          if (g && g.ops) ops = g.ops;
          if (g && g.logs) logs = g.logs;
        }
        const pl = B.plan(cur, state.counters, ops, opts);
        if (pl.conflicts.length) return { ok: false, conflicts: pl.conflicts };
        if (logs.length) this.stockLogSync(logs, true);
        for (const id of Object.keys(pl.updates)) {
          docs[id] = pl.updates[id];
          state.revs[col + '/' + id] = ((state.revs[col + '/' + id]) || 1) + 1;
        }
        state.counters = pl.counters;
        let version = null;
        if (Object.keys(pl.updates).length) { state.rev++; version = String(state.rev); save(); }
        else if (JSON.stringify(pl.counters) !== JSON.stringify(state.counters)) save();
        return { ok: true, version, assigned: pl.assigned, changed: Object.keys(pl.updates) };
      });
    },
    async version() {
      return String(state.rev);
    },
    async roles() {
      return Object.entries(Object.assign({}, ...[Object.fromEntries(Object.entries(P.PRESETS).map(([id, p]) => [id, { id, label: p.label, perms: p.perms, system: true }]))], state.roles || {})).map(([, r]) => r);
    },
    saveRole(r) { return serial(() => { state.roles = state.roles || {}; state.roles[r.id] = { id: r.id, label: r.label, perms: r.perms, system: !!r.system }; save(); }); },
    async settings() { return { estoque_modo: 'aviso', estoque_aviso_desde: (state.settings && state.settings.estoque_aviso_desde) || null, ...(state.settings || {}) }; },
    setSetting(k, v) { return serial(() => { state.settings = state.settings || {}; state.settings[k] = v; save(); }); },
    stockLogSync(entries, keep) { state.stockLog = state.stockLog || []; entries.forEach((e) => state.stockLog.push({ id: state.stockLog.length + 1, at: new Date().toISOString(), ...e })); if (!keep) save(); },
    async stockLog(entries) { this.stockLogSync(entries); },
    async stockLogList(limit) { return (state.stockLog || []).slice(-1 * (limit || 500)).reverse(); },
    async stockDocs(col) {
      const docs = state.cols[col] || {};
      const o = {};
      Object.keys(docs).filter((id) => STK.STOCK_DOC(id) || id === 'cadastros').forEach((id) => { o[id] = D.clone(docs[id]); });
      return o;
    },
    async put(col, id, data) {
      const r = await this.applyBatch(col, { [id]: (cur) => D.diffDoc(id, cur, data) }, {});
      return r.version || String(state.rev);
    },
    async users() {
      return (state.users || []).map((u) => ({ ...u }));
    },
    createUser(u) {
      return serial(() => {
        state.users = state.users || [];
        if (state.users.some((x) => x.username === u.username)) throw Object.assign(new Error('duplicado'), { code: '23505' });
        state.users.push({ ...u, created_at: new Date().toISOString(), last_login: null });
        save();
      });
    },
    updateUser(id, f) {
      return serial(() => {
        const u = (state.users || []).find((x) => x.id === id);
        if (u) Object.assign(u, f);
        save();
      });
    },
    remove(col, id) {
      return serial(() => {
        if (state.cols[col]) delete state.cols[col][id];
        state.rev++;
        save();
        return String(state.rev);
      });
    },
    async close() {},
  };
}

/* a numeração de vendas e compras pertence ao servidor: ela substitui a que estiver no documento */
function resolveOps(docsOps, cur) {
  const o = {};
  for (const id of Object.keys(docsOps)) o[id] = D.clone(typeof docsOps[id] === 'function' ? docsOps[id](cur[id] || null) : docsOps[id]);
  return o;
}
async function insertLog(q, entries) {
  for (const e of entries) {
    await q.query('INSERT INTO app_stock_log (kind, product_id, product_name, saldo, qty, user_id, user_name, authorized_by, justification, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
      [e.kind, e.product_id, e.product_name || null, e.saldo ?? null, e.qty ?? null, e.user_id || null, e.user_name || null, e.authorized_by || null, e.justification || null, JSON.stringify(e.detail || {})]);
  }
}

function withSeq(data, ctr) {
  if (!ctr || (ctr.venda === undefined && ctr.compra === undefined)) return data;
  const seq = { ...((data && data.seq) || {}) };
  if (ctr.venda !== undefined) seq.venda = Math.max(Number(seq.venda) || 0, ctr.venda);
  if (ctr.compra !== undefined) seq.compra = Math.max(Number(seq.compra) || 0, ctr.compra);
  return { ...(data || {}), seq };
}

/* Migrações: db/migrations/NNN_nome.sql, aplicadas em ordem, cada uma uma só vez e dentro de uma transação.
 * A trava (advisory lock) impede que duas cópias do servidor migrem ao mesmo tempo. */
async function runMigrations(pool) {
  const dir = path.join(__dirname, 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await c.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    for (const f of files) {
      const version = f.split('_')[0];
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(version)) {
        if (done.get(version) !== sum) console.warn(`Aviso: a migração ${f} mudou depois de aplicada (o banco não foi alterado).`);
        continue;
      }
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [version, f, sum]);
        await c.query('COMMIT');
        console.log(`Migração aplicada: ${f}`);
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (x) { /* ignora */ }
        throw new Error(`Falha na migração ${f}: ${e.message}`);
      }
    }
  } finally {
    try { await c.query('SELECT pg_advisory_unlock(727274)'); } catch (x) { /* ignora */ }
    c.release();
  }
}

module.exports = { createStore };
