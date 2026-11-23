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
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  return {
    kind: 'PostgreSQL',
    async init() {
      await pool.query(schema);
    },
    async list(col) {
      const r = await pool.query('SELECT id, data FROM app_docs WHERE col = $1 ORDER BY id', [col]);
      return r.rows.map((x) => ({ id: x.id, data: x.data }));
    },
    async version() {
      const r = await pool.query('SELECT last_value, is_called FROM app_docs_rev');
      return String(r.rows[0].is_called ? r.rows[0].last_value : 0);
    },
    async put(col, id, data) {
      const r = await pool.query(
        `WITH up AS (
           INSERT INTO app_docs (col, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
           RETURNING 1)
         SELECT nextval('app_docs_rev') AS v FROM up`,
        [col, id, JSON.stringify(data)]
      );
      return String(r.rows[0].v);
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
    },
    async list(col) {
      const docs = state.cols[col] || {};
      return Object.keys(docs).sort().map((id) => ({ id, data: docs[id] }));
    },
    async version() {
      return String(state.rev);
    },
    put(col, id, data) {
      return serial(() => {
        (state.cols[col] = state.cols[col] || {})[id] = data;
        state.rev++;
        save();
        return String(state.rev);
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

module.exports = { createStore };
