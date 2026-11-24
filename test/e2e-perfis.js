/* Etapa 2, navegador: menus por perfil, custo escondido, saldo do servidor no PDV, exceção de estoque com autorização do administrador. */
const {chromium}=require('/opt/npm-tools/node_modules/playwright');
const {execSync}=require('child_process');
const PORT=process.env.PORT||3112,URL='http://localhost:'+PORT;
const PSQL=(sql)=>execSync(`psql -X -q -A -t -h /tmp/pgsock -p 5433 -U postgres -d rose_e2e -c ${JSON.stringify(sql)}`).toString().trim();
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':' -> '+x))};
(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const errs=[];
async function login(user,pass){const ctx=await b.newContext({viewport:{width:1280,height:800}});const pg=await ctx.newPage();pg.on('pageerror',e=>errs.push(user+': '+e.message));
 await pg.goto(URL+'/login');await pg.fill('#u',user);await pg.fill('#p',pass);await pg.click('#go');await pg.waitForURL(URL+'/');await pg.waitForTimeout(1800);return pg}
const ev=(pg,fn,arg)=>pg.evaluate(([src,a])=>{const T=window.__T;return new Function('T','arg','const {A,S,C,CART,pdvTot,cxOpen,mark,render}=T;return ('+src+')(arg)')(T,a)},[fn.toString(),arg]);
const A=await login('rose','teste12345');
const mk=async(u,p,pf)=>A.evaluate(async([u,p,pf])=>(await fetch('/api/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:u,nome:'Teste '+u,senha:p,perfil:pf})})).status,[u,p,pf]);
await mk('cx1','cx12345678','caixa_vendas');await mk('est1','est12345678','estoque');await mk('con1','con12345678','consulta');
// produto de teste com estoque 2 e custo conhecido
await A.evaluate(async()=>{await fetch('/api/col/loja/_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs:{cadastros:[{k:'produtos',op:'put',id:'pz',before:null,after:{id:'pz',cod:'PZ1',nome:'Produto Z',cat:'Teste',custo:5.55,preco:9,min:1,fid:''}}],movimentos:[{k:'items',op:'put',id:'mz',before:null,after:{id:'mz',data:'2026-11-20',pid:'pz',tipo:'e',qtd:2,motivo:'Estoque inicial',obs:''}}]}})})});
await A.waitForTimeout(500);
if(!(await ev(A,()=>!!cxOpen()))){await A.goto(URL+'/#caixa');await A.waitForTimeout(500);await A.fill('#cx-ini','50');await A.click('[data-act=cxAbrir]');await A.waitForTimeout(800)}
// ---- Caixa/Vendas
const C1=await login('cx1','cx12345678');
const nav=await C1.locator('#snav').innerText();
ok('Caixa vê só Caixa, Vendas e Clientes no menu',/Caixa/.test(nav)&&/Vendas/.test(nav)&&/Clientes/.test(nav)&&!/Produtos|Financeiro|Compras|Fornecedores|Análise|Administração|Conferência/.test(nav),nav.replace(/\n/g,'|'));
ok('Caixa: nenhum custo chegou ao navegador',await ev(C1,()=>S.produtos.length>0&&S.produtos.every(p=>p.custo===undefined)));
ok('Caixa: saldo de estoque vem do servidor',await ev(C1,()=>!!S.saldos&&C.st['pz']===2),await ev(C1,()=>C.st['pz']));
ok('Caixa: sem lançamentos de despesa e sem compras',await ev(C1,()=>S.compras.length===0&&S.lancamentos.every(l=>l.tipo==='r')));
await C1.goto(URL+'/#produtos');await C1.waitForTimeout(500);
ok('Caixa abrindo #produtos volta para uma tela permitida',!(await C1.locator('h1,h2').allInnerTexts()).join(' ').includes('Cadastro de produtos'));
// ---- exceção de estoque no PDV
await C1.goto(URL+'/#caixa');await C1.waitForTimeout(600);
if(!(await ev(C1,()=>!!cxOpen())))console.log('  (caixa não está aberto para o Caixa)');
await C1.fill('#pdv-bar','3*PZ1');await C1.press('#pdv-bar','Enter');await C1.waitForTimeout(300);
const vend0=Number(PSQL("select coalesce(sum(jsonb_array_length(data->'items')),0) from app_docs where id like 'vendas-%'"));
await C1.click('[data-act=pdvFim]');await C1.waitForTimeout(600);
ok('PDV: venda acima do estoque abre a autorização do administrador',await C1.locator('#exok').count()===1);
await C1.fill('dialog[aria-label="Autorização do administrador"] [name=u]','rose');await C1.fill('dialog[aria-label="Autorização do administrador"] [name=p]','senha errada');await C1.fill('dialog[aria-label="Autorização do administrador"] [name=j]','Cliente levou o último e há mais no depósito');await C1.click('#exok');await C1.waitForTimeout(700);
ok('PDV: senha errada do administrador é recusada',/incorretos/.test(await C1.locator('#exerr').innerText()));
await C1.fill('dialog[aria-label="Autorização do administrador"] [name=p]','teste12345');await C1.click('#exok');await C1.waitForTimeout(2500);
const vend1=Number(PSQL("select coalesce(sum(jsonb_array_length(data->'items')),0) from app_docs where id like 'vendas-%'"));
ok('PDV: com a autorização a venda é gravada',vend1===vend0+1,[vend0,vend1]);
const lg=PSQL("select kind||'|'||user_name||'|'||authorized_by||'|'||justification from app_stock_log where kind='excecao' order by id desc limit 1");
ok('registro da exceção: quem pediu, quem autorizou e a justificativa',/^excecao\|Teste cx1\|Rose\|Cliente levou/.test(lg),lg);
ok('o custo real foi gravado na venda do Caixa (que não vê custo)',PSQL("select count(*) from app_docs d, jsonb_array_elements(d.data->'items') v, jsonb_array_elements(v->'it') i where d.id like 'vendas-%' and i->>0='pz' and (i->>3)::numeric=5.55")==='1');
// ---- Estoque
const E1=await login('est1','est12345678');
await E1.goto(URL+'/#produtos');await E1.waitForTimeout(700);
const th=(await E1.locator('thead').first().innerText());
ok('Estoque: tabela de produtos sem Custo nem Margem',/Preço/.test(th)&&!/Custo|Margem/.test(th),th.replace(/\n/g,'|'));
await E1.click('[data-act=novoProd]');await E1.waitForTimeout(400);
ok('Estoque: formulário de produto sem campo de custo',await E1.locator('input[name=custo]').count()===0);
await E1.keyboard.press('Escape');
ok('Estoque: nenhuma venda nem lançamento chegou ao navegador',await ev(E1,()=>S.vendas.length===0&&S.lancamentos.length===0&&S.clientes.length===0));
ok('Estoque vê o menu de conferência',/Conferência de estoque/.test(await E1.locator('#snav').innerText()));
// ---- Consulta
const K1=await login('con1','con12345678');
const nk=await K1.locator('#snav').innerText();
ok('Consulta vê todas as telas e não vê Administração',/Financeiro/.test(nk)&&/Produtos/.test(nk)&&!/Administração/.test(nk),nk.replace(/\n/g,'|'));
ok('Consulta vê custo e margem',await ev(K1,()=>S.produtos.some(p=>p.custo>0)));
await K1.goto(URL+'/#produtos');await K1.waitForTimeout(500);
ok('Consulta: tabela com Custo e Margem',/Custo/.test(await K1.locator('thead').first().innerText()));
// ---- páginas administrativas
await A.goto(URL+'/estoque-conferencia');await A.waitForTimeout(1500);
ok('Conferência de estoque abre para o administrador, com produtos e registro',await A.locator('#linhas tr').count()>5&&/Exceção/.test(await A.locator('#reg').innerText()));
await A.goto(URL+'/usuarios');await A.waitForTimeout(1500);
ok('Usuários e perfis lista as pessoas e os perfis',await A.locator('.user').count()>=4&&(await A.locator('#pf-sel option').count())>=8);
const c2=await login('cx1','cx12345678');await c2.goto(URL+'/usuarios');await c2.waitForTimeout(600);
ok('Caixa não consegue abrir /usuarios nem /estoque-conferencia',!/Pessoas cadastradas/.test(await c2.content()));
await c2.goto(URL+'/estoque-conferencia');await c2.waitForTimeout(600);ok('Caixa não abre a conferência',!/Conferência de estoque<\/h1>/.test(await c2.content()));
console.log('erros de página:',errs.length?errs.join(' | '):'nenhum');
console.log(`\n${pass} passaram, ${fail} falharam`);await b.close();process.exit(fail?1:0)})().catch(e=>{console.error('ERRO',e.message);process.exit(1)});
