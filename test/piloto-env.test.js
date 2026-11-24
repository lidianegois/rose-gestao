'use strict';
/* Serviço de piloto: PLANO_PILOTO, confirmação do banco de teste antes de migrar e criação inicial da TI-Lidiane via TI_SENHA.
 * Uso: PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/piloto-env.test.js */
const { execSync, spawn } = require('child_process');
const H = process.env.PGHOST, PT = process.env.PGPORT;
const PSQL = (db, sql) => execSync(`psql -X -q -A -t -h ${H} -p ${PT} -U postgres -d ${db} -c ${JSON.stringify(sql)} 2>&1 || true`).toString().trim();
const fresh = (db) => { try { execSync(`dropdb -h ${H} -p ${PT} -U postgres --if-exists ${db}`); } catch (e) { /* ok */ } execSync(`createdb -h ${H} -p ${PT} -U postgres ${db}`); };
let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const SEG = { rose: 'senha-rose-teste-9', ti: 'senha-ti-teste-9', ti2: 'outra-senha-ti-9', sess: 'segredo-longo-de-teste-xyz' };
let log = '';
function run(db, env, port) {
  log = '';
  const proc = spawn('node', ['server.js'], { env: { ...process.env, DATABASE_URL: `postgres://postgres@localhost:${PT}/${db}`, PORT: String(port), SESSION_SECRET: SEG.sess, APP_USER: 'rose', APP_PASSWORD: SEG.rose, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  return proc;
}
async function up(proc, port) {
  for (let i = 0; i < 80; i++) { if (proc.exitCode !== null) return false; try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch (e) { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const stop = async (p) => { if (p && p.exitCode === null) { p.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); } };
async function login(port, u, s) { const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: u, senha: s }) }); if (!r.ok) return null; return (r.headers.get('set-cookie') || '').split(';')[0]; }
const me = async (port, ck) => (await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie: ck } })).json()).user;
const OK_DB = 'rose_gestao_teste_db';

(async () => {
  /* 1) banco errado + modo piloto: para antes de qualquer alteração */
  fresh('t_pwrong');
  let p = run('t_pwrong', { PLANO_PILOTO: 'basico' }, 3420);
  const sobe = await up(p, 3420); await new Promise((r) => setTimeout(r, 600));
  ok('banco diferente do esperado: o servidor não inicia', !sobe && p.exitCode !== null && p.exitCode !== 0, p.exitCode);
  ok('banco diferente do esperado: nenhuma tabela criada, nenhuma migração', PSQL('t_pwrong', "select count(*) from information_schema.tables where table_schema='public'") === '0');
  ok('mensagem de parada clara, sem senha nem endereço do banco', /Modo piloto/.test(log) && !log.includes(SEG.rose) && !/postgres:\/\//.test(log), log.slice(0, 200));
  await stop(p);
  p = run('t_pwrong', { TI_SENHA: SEG.ti }, 3420);
  ok('com TI_SENHA e banco diferente: também não inicia', !(await up(p, 3420)) && p.exitCode !== 0);
  await stop(p);
  /* sem variáveis de piloto o comportamento de antes continua */
  p = run('t_pwrong', {}, 3420);
  ok('sem variáveis de piloto, o serviço inicia em qualquer banco (como antes)', await up(p, 3420));
  await stop(p);

  /* 1b) DATABASE_URL vazia ou ausente + modo piloto: recusa antes de criar contas ou gravar dados */
  const fs = require('fs'), path = require('path');
  const dataFile = path.join(__dirname, '..', 'data', 'banco-local.json');
  const existia = fs.existsSync(dataFile);
  for (const [rotulo, env] of [['PLANO_PILOTO', { PLANO_PILOTO: 'basico' }], ['TI_SENHA', { TI_SENHA: SEG.ti }], ['PLANO_PILOTO completo + TI_SENHA', { PLANO_PILOTO: 'completo', TI_SENHA: SEG.ti }]]) {
    for (const vazio of ['', '   ', null]) {
      log = '';
      const envp = { ...process.env, PORT: '3427', SESSION_SECRET: SEG.sess, APP_USER: 'rose', APP_PASSWORD: SEG.rose, ...env };
      if (vazio === null) delete envp.DATABASE_URL; else envp.DATABASE_URL = vazio;
      const q = spawn('node', ['server.js'], { env: envp, stdio: ['ignore', 'pipe', 'pipe'] });
      q.stdout.on('data', (d) => { log += d; }); q.stderr.on('data', (d) => { log += d; });
      const subiu = await up(q, 3427); await new Promise((r) => setTimeout(r, 400));
      ok(`${rotulo} com DATABASE_URL ${vazio === null ? 'ausente' : vazio === '' ? 'vazia' : 'em branco'}: não inicia`, !subiu && q.exitCode !== null && q.exitCode !== 0, q.exitCode);
      ok('  mensagem clara, sem senhas', /DATABASE_URL não está definida/.test(log) && !log.includes(SEG.rose) && !log.includes(SEG.ti), log.slice(0, 200));
      await stop(q);
    }
  }
  ok('DATABASE_URL vazia: nenhum arquivo local de dados foi criado', existia || !fs.existsSync(dataFile));
  /* o script de criação da conta também recusa */
  const sc = require('child_process').spawnSync('node', ['scripts/criar-ti-lidiane.js'], { env: { ...process.env, DATABASE_URL: '', TI_SENHA: SEG.ti, PILOTO_BANCO: OK_DB }, encoding: 'utf8' });
  ok('script criar-ti-lidiane com DATABASE_URL vazia: recusa', sc.status !== 0 && /DATABASE_URL não está definida/.test(sc.stderr + sc.stdout) && !(sc.stdout + sc.stderr).includes(SEG.ti));

  /* 2) banco de teste esperado, Básico, com TI_SENHA (deve ser ignorada) */
  fresh(OK_DB);
  p = run(OK_DB, { PLANO_PILOTO: 'basico', TI_SENHA: SEG.ti }, 3421);
  ok('banco esperado + Básico: inicia', await up(p, 3421), log.slice(0, 300));
  const NMIG = String(require('fs').readdirSync('db/migrations').filter((f) => /^\d+_.+\.sql$/.test(f)).length);
  ok('todas as migrações (incluindo a 004) aplicadas só no banco de teste', PSQL(OK_DB, 'select count(*) from schema_migrations') === NMIG && PSQL(OK_DB, "select count(*) from schema_migrations where version='004'") === '1', NMIG);
  let ck = await login(3421, 'rose', SEG.rose); let m = ck && (await me(3421, ck));
  ok('Rose entra no Básico e /api/me mostra plano basico', m && m.plano === 'basico' && m.perm.includes('financeiro.dre'), m && m.plano);
  ok('TI_SENHA ignorada no Básico: conta TI-Lidiane não existe', PSQL(OK_DB, "select count(*) from app_users where username='ti-lidiane'") === '0' && (await login(3421, 'ti-lidiane', SEG.ti)) === null);
  await stop(p);

  /* 3) alterna para Completo com TI_SENHA: cria a conta uma vez */
  p = run(OK_DB, { PLANO_PILOTO: 'completo', TI_SENHA: SEG.ti }, 3422);
  ok('alternar para Completo: inicia', await up(p, 3422), log.slice(0, 300));
  const ckT = await login(3422, 'ti-lidiane', SEG.ti); const mt = ckT && (await me(3422, ckT));
  ok('TI-Lidiane entra no Completo, vê o card Resultado e não tem as ações sensíveis', mt && mt.plano === 'completo' && mt.perm.includes('financeiro.dre') && !mt.perm.includes('dados.apagar') && !mt.perm.includes('backup.restaurar') && !mt.perm.includes('config.editar'), mt && mt.plano);
  const hash1 = PSQL(OK_DB, "select pass from app_users where username='ti-lidiane'");
  ok('log não contém senhas', !log.includes(SEG.ti) && !log.includes(SEG.rose) && !log.includes(SEG.sess));
  await stop(p);

  /* 4) reinicia sem TI_SENHA: a conta continua funcionando */
  p = run(OK_DB, { PLANO_PILOTO: 'completo' }, 3423);
  ok('reinício sem TI_SENHA: inicia', await up(p, 3423));
  ok('login da TI-Lidiane continua funcionando sem a variável', (await login(3423, 'ti-lidiane', SEG.ti)) !== null);
  ok('senha errada continua recusada', (await login(3423, 'ti-lidiane', 'senha-errada-123')) === null);
  await stop(p);
  /* 4b) TI_SENHA diferente não altera uma conta que já existe */
  p = run(OK_DB, { PLANO_PILOTO: 'completo', TI_SENHA: SEG.ti2 }, 3424);
  ok('TI_SENHA nova não troca a senha da conta existente', await up(p, 3424) && (await login(3424, 'ti-lidiane', SEG.ti2)) === null && (await login(3424, 'ti-lidiane', SEG.ti)) !== null && PSQL(OK_DB, "select pass from app_users where username='ti-lidiane'") === hash1);
  await stop(p);

  /* 5) volta ao Básico: TI-Lidiane sem permissões, Rose limitada; PLANO_PILOTO manda sobre a configuração do banco */
  PSQL(OK_DB, `insert into app_settings(key,value) values ('plano','"completo"') on conflict (key) do update set value=excluded.value`);
  p = run(OK_DB, { PLANO_PILOTO: 'basico' }, 3425);
  ok('Básico de novo: inicia', await up(p, 3425));
  const ck5 = await login(3425, 'ti-lidiane', SEG.ti); const m5 = ck5 && (await me(3425, ck5));
  ok('no Básico a TI-Lidiane fica sem permissões', m5 && m5.plano === 'basico' && m5.perm.length === 0, m5 && m5.perm.length);
  const ck6 = await login(3425, 'rose', SEG.rose); const m6 = await me(3425, ck6);
  ok('PLANO_PILOTO prevalece sobre o plano gravado no banco (Rose segue no Básico)', m6.plano === 'basico' && m6.perm.includes('financeiro.dre') && !m6.perm.includes('analise.ver'));
  ok('valor inválido em PLANO_PILOTO é ignorado (usa o plano do banco)', await (async () => { await stop(p); p = run(OK_DB, { PLANO_PILOTO: 'xyz' }, 3426); if (!(await up(p, 3426))) return false; const c = await login(3426, 'rose', SEG.rose); return (await me(3426, c)).plano === 'completo'; })());
  await stop(p);
  console.log(`\n${passed} passaram, ${failed} falharam`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
