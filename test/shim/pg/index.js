'use strict';
/*
 * SÓ PARA TESTES: imita o módulo "pg" usando o psql, para rodar o servidor contra um PostgreSQL real
 * quando não há acesso à internet para instalar o pacote. Cada "cliente" é uma sessão psql própria,
 * então travas, transações e concorrência são as do PostgreSQL de verdade.
 */
const { spawn } = require('child_process');
const FS = '\x1f', END = '@@FIM@@';

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Array.isArray(v)) return 'ARRAY[' + v.map(lit).join(',') + ']::text[]';
  if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function bind(sql, params) {
  if (!params || !params.length) return sql;
  return sql.replace(/\$(\d+)/g, (m, n) => lit(params[+n - 1]));
}

class Client {
  constructor(cfg) {
    this.cfg = cfg;
    this.q = Promise.resolve();
    this.buf = ''; this.err = '';
    this.p = spawn('psql', ['-X', '-q', '-A', '-F', FS, '-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user, '-d', cfg.database, '-v', 'ON_ERROR_STOP=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout.on('data', (d) => { this.buf += d; this.check(); });
    this.p.stderr.on('data', (d) => { this.err += d; this.check(); });
    this.p.stdin.write("\\pset footer off\n\\pset null ''\n");
    this.waiter = null;
  }
  check() {
    if (this.waiter && this.buf.includes(END + '\n') && this.err.includes(END + '\n')) {
      const w = this.waiter; this.waiter = null;
      const out = this.buf.split(END + '\n')[0], er = this.err.split(END + '\n')[0].trim();
      this.buf = this.buf.split(END + '\n').slice(1).join(END + '\n'); this.err = this.err.split(END + '\n').slice(1).join(END + '\n');
      w(out, er);
    }
  }
  query(text, params) {
    const run = () => new Promise((resolve, reject) => {
      this.waiter = (out, er) => {
        if (/^ERROR:|^FATAL:/m.test(er)) return reject(Object.assign(new Error(er.replace(/^ERROR:\s*/, '').split('\n')[0]), { detail: er }));
        const lines = out.split('\n').filter((l) => l.length);
        const rows = [];
        if (lines.length) {
          const cols = lines[0].split(FS);
          for (const l of lines.slice(1)) {
            const f = l.split(FS), o = {};
            cols.forEach((c, i) => { o[c] = f[i] === undefined ? '' : f[i]; });
            ['is_called', 'active'].forEach((c) => { if (c in o) o[c] = o[c] === 't'; }); // o psql imprime booleanos como t/f
            if ('data' in o && o.data !== '') { try { o.data = JSON.parse(o.data); } catch (e) { /* mantém texto */ } }
            rows.push(o);
          }
        }
        resolve({ rows, rowCount: rows.length });
      };
      this.p.stdin.write(bind(text, params) + ';\n\\echo ' + END + '\n\\warn ' + END + '\n');
    });
    return (this.q = this.q.then(run, run));
  }
  release() { if (this.pool) this.pool.free(this); }
  end() { try { this.p.stdin.end('\\q\n'); } catch (e) { /* ok */ } }
}

class Pool {
  constructor(o) {
    const u = new URL(o.connectionString);
    this.cfg = { host: process.env.PGHOST || u.hostname, port: process.env.PGPORT || u.port || 5432, user: decodeURIComponent(u.username || 'postgres'), database: u.pathname.slice(1) };
    this.max = o.max || 5; this.idle = []; this.all = []; this.waiting = [];
  }
  async connect() {
    if (this.idle.length) return this.idle.pop();
    if (this.all.length < this.max) { const c = new Client(this.cfg); c.pool = this; this.all.push(c); return c; }
    return new Promise((r) => this.waiting.push(r));
  }
  free(c) { const w = this.waiting.shift(); if (w) w(c); else this.idle.push(c); }
  async query(t, p) { const c = await this.connect(); try { return await c.query(t, p); } finally { c.release(); } }
  async end() { this.all.forEach((c) => c.end()); }
}
module.exports = { Pool };
