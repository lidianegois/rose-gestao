'use strict';
/*
 * Cria o perfil interno TI-Lidiane e a conta individual de teste. Uso só em ambiente de teste (plano completo).
 * A senha vem da variável TI_SENHA (nunca é impressa). Não rode na produção da Rose.
 * Uso: DATABASE_URL=... TI_SENHA='...' [TI_USUARIO=ti-lidiane] node scripts/criar-ti-lidiane.js
 */
const crypto = require('crypto');
const PL = require('../lib/plans.js');
const P = require('../lib/perms.js');
(async () => {
  const senha = process.env.TI_SENHA || '';
  if (senha.length < 8) { console.error('Defina TI_SENHA com pelo menos 8 caracteres.'); process.exit(1); }
  const store = require('../storage.js').createStore();
  await store.init();
  const st = await store.settings();
  if (PL.nome(st.plano) !== 'completo') { console.error('Este banco não está no plano completo; a conta TI-Lidiane não é criada aqui.'); process.exit(2); }
  await store.saveRole(PL.TI_LIDIANE);
  const username = process.env.TI_USUARIO || 'ti-lidiane';
  const hashPassword = (pass) => new Promise((resolve, reject) => { const salt = crypto.randomBytes(16); crypto.scrypt(pass, salt, 64, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`))); });
  const list = await store.users();
  if (!list.some((u) => u.username === username)) {
    await store.createUser({ id: 'u' + crypto.randomBytes(6).toString('hex'), username, name: 'TI-Lidiane', pass: await hashPassword(senha), role: P.LEGACY_ROLE('ti_lidiane'), role_id: 'ti_lidiane', perm_grant: [], perm_deny: [], active: true, pwv: 1 });
  }
  console.log('Perfil TI-Lidiane e conta ' + username + ' prontos.');
  await store.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
