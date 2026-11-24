const {chromium}=require('/opt/npm-tools/node_modules/playwright');
(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const ctx=await b.newContext({viewport:{width:1280,height:800}});const pg=await ctx.newPage();
const ev=(fn,arg)=>pg.evaluate(([src,a])=>{const T=window.__T;return new Function('T','arg','const {A,S,C,CART,ESPERA,pdvTot,pdvRest,cxRes,cxOpen,cupomHTML}=T;return ('+src+')(arg)')(T,a)},[fn.toString(),arg]);
const errs=[];pg.on('pageerror',e=>errs.push(e.message));pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await pg.goto('http://localhost:'+(process.env.PORT||3111)+'/login');await pg.fill('#u','rose');await pg.fill('#p','teste12345');await pg.click('#go');
await pg.waitForURL('http://localhost:'+(process.env.PORT||3111)+'/');await pg.waitForTimeout(1500);
await ev(()=>A.seed());await pg.waitForTimeout(800);
await pg.goto('http://localhost:'+(process.env.PORT||3111)+'/#caixa');await pg.waitForTimeout(800);
console.log('  produtos',await ev(()=>S.produtos.length),'cx abertos',await ev(()=>S.caixas.filter(c=>!c.fechado).length));if(await pg.locator('#cx-ini').count()){await pg.fill('#cx-ini','100');await pg.click('[data-act=cxAbrir]');await pg.waitForTimeout(500)}
const ok=(n,c)=>console.log((c?'PASS ':'FAIL ')+n);
// qty*search via name
const nome=await ev(()=>S.produtos.find(p=>(C.st[p.id]||0)>5).cod);
await pg.fill('#pdv-bar','3*'+nome);await pg.press('#pdv-bar','Enter');await pg.waitForTimeout(300);
ok('3*codigo adiciona 3',await ev(()=>CART[0]&&CART[0].q===3));
ok('banner ultimo item',await pg.locator('.litem').count()===1);
// click product from grid
await pg.locator('.pgrid button:not(.zero)').nth(1).click();await pg.waitForTimeout(200);
const tot0=await ev(()=>pdvTot());
// discount %
await pg.selectOption('#pdv-dt','p');await pg.fill('#pdv-desc','10');await pg.waitForTimeout(200);
const tot1=await ev(()=>pdvTot());
ok('desconto 10% ('+tot0+'->'+tot1+')',Math.abs(tot1-tot0*0.9)<0.02);
// qty input
await pg.fill('#cq0','2');await pg.press('#cq0','Tab');await pg.waitForTimeout(200);
ok('qty digitada=2',await ev(()=>CART[0].q===2));
// split payment
await pg.click('[data-act=pdvSplit]');await pg.waitForTimeout(150);
const t=await ev(()=>pdvTot());
await pg.fill('#pdv-pv',String(Math.round(t*50)/100));await pg.click('[data-act=pdvAddPay][data-id="Pix"]');await pg.waitForTimeout(150);
ok('finalizar bloqueado c/ falta',await pg.locator('[data-act=pdvFim]').isDisabled());
await pg.fill('#pdv-pv',String(Math.ceil(t)+5));await pg.click('[data-act=pdvAddPay][data-id="Dinheiro"]');await pg.waitForTimeout(200);
const trocoUI=await pg.locator('.troco').innerText();console.log('  ',trocoUI);
ok('pagamento completo c/ troco',/troco/i.test(trocoUI));
const nv0=await ev(()=>S.vendas.length);const d0=await ev(()=>cxRes(cxOpen()).by['Dinheiro']);
await pg.click('[data-act=pdvFim]');await pg.waitForTimeout(500);
const v=await ev(()=>S.vendas.at(-1));console.log('  venda',JSON.stringify({pag:v.pag,pgs:v.pgs,tr:v.tr,desc:v.desc,tot:v.it.reduce((a,i)=>a+i[1]*i[2],0)-v.desc}));
ok('venda gravada c/ pgs',(await ev(()=>S.vendas.length))===nv0+1&&v.pgs&&v.pgs.length===2&&v.tr>0);
ok('soma pgs = total',Math.abs(v.pgs.reduce((a,x)=>a+x[1],0)-(v.it.reduce((a,i)=>a+i[1]*i[2],0)-v.desc))<0.01);
const esp=await ev(()=>cxRes(cxOpen()));console.log('  cx',JSON.stringify(esp.by),esp.esp);
ok('dinheiro do caixa subiu so a parte em dinheiro',Math.abs(esp.by['Dinheiro']-d0-v.pgs.find(x=>x[0]==='Dinheiro')[1])<0.01);
// espera
await pg.fill('#pdv-bar',nome);await pg.press('#pdv-bar','Enter');await pg.waitForTimeout(200);
await pg.keyboard.press('F6');await pg.waitForTimeout(200);
ok('F6 coloca em espera',await ev(()=>ESPERA.length===1&&CART.length===0));
await pg.click('[data-act=espRet]');await pg.waitForTimeout(200);
ok('retomar',await ev(()=>ESPERA.length===0&&CART.length===1));
await pg.keyboard.press('F2');ok('F2 foca busca',await ev(()=>document.activeElement.id==='pdv-bar'));
await pg.keyboard.press('F4');ok('F4 foca desconto',await ev(()=>document.activeElement.id==='pdv-desc'));
await pg.keyboard.press('F9');await pg.waitForTimeout(400);ok('F9 finaliza (pix)',await ev((n)=>S.vendas.length===n+2&&CART.length===0,nv0));
// fiado split needs client
// cupom html
const html=await ev((id)=>cupomHTML(S.vendas.find(x=>x.id===id)),v.id);ok('cupom tem total e pagamentos',/TOTAL/.test(html)&&/Troco/.test(html)&&/Pix/.test(html));
await pg.screenshot({path:'/tmp/pdv-desk.png'});
// tela cheia
await pg.click('[data-act=pdvFull]');await pg.waitForTimeout(300);
ok('modo tela cheia esconde menu',!(await pg.locator('#side').isVisible()));
await pg.screenshot({path:'/tmp/pdv-full.png'});
await ev(()=>A.pdvFull());await pg.waitForTimeout(200);
// relatorios nao quebram
for(const h of ['vendas','financeiro-caixa','financeiro','painel']){await pg.goto('http://localhost:'+(process.env.PORT||3111)+'/#'+h);await pg.waitForTimeout(500)}
// mobile
const m=await ctx.newPage();await m.setViewportSize({width:390,height:844});await m.goto('http://localhost:'+(process.env.PORT||3111)+'/#caixa');await m.waitForTimeout(1200);
await m.locator('.pgrid button:not(.zero)').first().click();await m.waitForTimeout(300);
ok('mobile sem overflow horizontal',await m.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
await m.screenshot({path:'/tmp/pdv-mob.png'});
console.log('erros:',errs.length?errs:'nenhum');
await b.close();})().catch(e=>{console.log('ERRO',e.message);process.exit(1)});
