const {chromium}=require('/opt/npm-tools/node_modules/playwright');
const {execSync}=require('child_process');
const PORT=process.env.PORT||3112,URL='http://localhost:'+PORT;
const PSQL=(sql)=>execSync(`psql -X -q -A -t -h /tmp/pgsock -p 5433 -U postgres -d rose_e2e -c ${JSON.stringify(sql)}`).toString().trim();
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':' -> '+x))};
const mkEv=(pg)=>(fn,arg)=>pg.evaluate(([src,a])=>{const T=window.__T;return new Function('T','arg','const {A,S,C,CART,ESPERA,LAST,pdvTot,pdvRest,cxRes,cxOpen,mark,render}=T;return ('+src+')(arg)')(T,a)},[fn.toString(),arg]);
(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const errs=[];
async function login(user,pass){const ctx=await b.newContext({viewport:{width:1280,height:800}});const pg=await ctx.newPage();pg.on('pageerror',e=>errs.push(user+': '+e.message));
 await pg.goto(URL+'/login');await pg.fill('#u',user);await pg.fill('#p',pass);await pg.click('#go');await pg.waitForURL(URL+'/');await pg.waitForTimeout(1500);return {pg,ev:mkEv(pg),ctx}}
const A=await login('rose','teste12345');
// cria a usuária ana (Caixa) e entra
const r=await A.pg.evaluate(async()=>{const x=await fetch('/api/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:'ana',nome:'Ana Souza',senha:'ana12345678',papel:'caixa'})});return x.status});
ok('usuária ana criada',r===201||r===409);
const B=await login('ana','ana12345678');
// dados de exemplo (modo importação) pela administradora
await A.ev(()=>A.seed());await A.pg.waitForTimeout(2500);
const dbv=()=>Number(PSQL("select coalesce(sum(jsonb_array_length(data->'items')),0) from app_docs where id like 'vendas-%'"));
const cnt=()=>Number(PSQL("select value from app_counters where name='venda'"));
const maxn=()=>Number(PSQL("select max((v->>'n')::int) from app_docs d, jsonb_array_elements(d.data->'items') v where d.id like 'vendas-%'"));
ok('exemplo gravado em modo importação: números preservados e contador >= maior número',dbv()>0&&cnt()>=maxn()&&PSQL("select count(*) from (select v->>'n' n from app_docs d, jsonb_array_elements(d.data->'items') v where d.id like 'vendas-%' group by 1 having count(*)>1) x")==='0',cnt()+' vs '+maxn());
await B.pg.waitForFunction(()=>window.__T&&window.__T.S.produtos.length>0&&window.__T.S.vendas.length>3000,null,{timeout:30000}).catch(()=>{});await B.pg.waitForTimeout(1500);
ok('B (Caixa) recebeu os dados de A',await B.ev(()=>S.produtos.length)>0&&await B.ev(()=>S.vendas.length)===dbv(),await B.ev(()=>S.vendas.length)+' vs '+dbv());
// caixa aberto
if(!(await A.ev(()=>!!cxOpen()))){await A.pg.goto(URL+'/#caixa');await A.pg.waitForTimeout(500);await A.pg.fill('#cx-ini','50');await A.pg.click('[data-act=cxAbrir]');await A.pg.waitForTimeout(800)}
await B.pg.waitForFunction(()=>window.__T&&!!window.__T.cxOpen(),null,{timeout:30000}).catch(()=>{});
await A.pg.goto(URL+'/#caixa');await B.pg.goto(URL+'/#caixa');await A.pg.waitForTimeout(600);await B.pg.waitForTimeout(600);
ok('B vê o caixa aberto por A',await B.ev(()=>!!cxOpen()));
const code=await A.ev(()=>S.produtos.find(p=>(C.st[p.id]||0)>80).cod);
// ---- S1: vendas simultâneas pela interface
const v0=dbv(),c0=cnt();
const sell=async(P,k)=>{for(let i=0;i<k;i++){await P.pg.fill('#pdv-bar',code);await P.pg.press('#pdv-bar','Enter');await P.pg.waitForTimeout(80);await P.pg.keyboard.press('F9');await P.pg.waitForTimeout(120)}};
await Promise.all([sell(A,6),sell(B,6)]);
await A.pg.waitForTimeout(2500);await B.pg.waitForTimeout(2500);
ok('12 vendas simultâneas gravadas',dbv()-v0===12,dbv()-v0);
const novos=PSQL(`select string_agg((v->>'n'),',' order by (v->>'n')::int) from app_docs d, jsonb_array_elements(d.data->'items') v where d.id like 'vendas-%' and (v->>'n')::int>${c0}`).split(',').map(Number);
ok('números novos únicos e contínuos',new Set(novos).size===12&&novos[0]===c0+1&&novos[11]===c0+12,novos.join());
ok('contador = último número',cnt()===c0+12);
await A.pg.waitForTimeout(5000);await B.pg.waitForTimeout(5000);
const ids=(P)=>P.ev(()=>S.vendas.map(v=>v.n).sort((a,b)=>a-b).join(','));
const dbn=PSQL("select string_agg((v->>'n'),',' order by (v->>'n')::int) from app_docs d, jsonb_array_elements(d.data->'items') v where d.id like 'vendas-%'");
ok('tela de A igual ao banco',await ids(A)===dbn);ok('tela de B igual ao banco',await ids(B)===dbn);
ok('A e B mostram o número definitivo da última venda',await A.ev(()=>LAST&&S.vendas.find(v=>v.id===LAST.id)&&LAST.n===S.vendas.find(v=>v.id===LAST.id).n));
// ---- S2: A muda preço de produto enquanto B vende
const pid=await A.ev(()=>S.produtos[1].id);const preco0=await A.ev(()=>S.produtos[1].preco);
const vv0=dbv();
await Promise.all([A.ev(()=>{S.produtos[1].preco=77.77;mark('cadastros')}),sell(B,3)]);
await A.pg.waitForTimeout(3000);await B.pg.waitForTimeout(3000);
ok('preço alterado por A gravado',PSQL(`select count(*) from app_docs d, jsonb_array_elements(d.data->'produtos') p where d.id='cadastros' and p->>'id'='${pid}' and (p->>'preco')::numeric=77.77`)==='1');
ok('as 3 vendas de B gravadas',dbv()-vv0===3);
await A.pg.waitForTimeout(5000);
ok('B vê o novo preço',await B.ev(()=>S.produtos[1].preco)===77.77);
// ---- S3: mesmo lançamento baixado por A e B ao mesmo tempo
const lid=await A.ev(()=>S.lancamentos.find(l=>l.tipo==='d'&&!l.pago).id);
await Promise.all([A.ev((id)=>{const l=S.lancamentos.find(x=>x.id===id);l.pago='2026-11-23';l.vpago=111;mark('lancamentos')},lid),B.ev((id)=>{const l=S.lancamentos.find(x=>x.id===id);l.pago='2026-11-23';l.vpago=222;mark('lancamentos')},lid)]);
await A.pg.waitForTimeout(3500);await B.pg.waitForTimeout(3500);
const vp=Number(PSQL(`select (l->>'vpago')::numeric from app_docs d, jsonb_array_elements(d.data->'items') l where d.id='lancamentos' and l->>'id'='${lid}'`));
ok('mesmo registro: o banco tem uma só das versões',vp===111||vp===222,vp);
await A.pg.waitForTimeout(5000);await B.pg.waitForTimeout(1500);
const va=await A.ev((id)=>S.lancamentos.find(x=>x.id===id).vpago,lid),vb=await B.ev((id)=>S.lancamentos.find(x=>x.id===id).vpago,lid);
ok('A e B terminam vendo o mesmo valor do banco',va===vp&&vb===vp,va+'/'+vb+'/'+vp);
// ---- S4: segurança do papel Caixa
const st=await B.pg.evaluate(async()=>{const get=await (await fetch('/api/col/loja')).json();const d=get.docs.find(x=>x.id==='lancamentos').data;
 const r1=await fetch('/api/col/loja/_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs:{compras:[{k:'items',op:'put',id:'zz',before:null,after:{id:'zz'}}]}})});
 const r2=await fetch('/api/col/loja/_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs:{lancamentos:[{k:'items',op:'del',id:d.items[0].id,before:d.items[0]}]}})});
 d.items.shift();const r3=await fetch('/api/col/loja/lancamentos',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
 const r4=await fetch('/api/col/loja/_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs:{lancamentos:[{k:'items',op:'put',id:'lz',before:null,after:{id:'lz',valor:1}}]},bulk:true})});
 return [r1.status,r2.status,r3.status,r4.status]});
ok('Caixa: não grava compras (403), não apaga via lote (403), não apaga via PUT antigo (403)',st[0]===403&&st[1]===403&&st[2]===403,st.join());
ok('Caixa: gravar lançamento permitido (bulk ignorado para não-admin)',st[3]===200,st[3]);
// ---- S5: recarregar e continuar numeração
const c1=cnt();await A.pg.reload();await A.pg.waitForTimeout(2500);await A.pg.goto(URL+'/#caixa');await A.pg.waitForTimeout(800);
ok('após recarregar, tela = banco',await A.ev(()=>S.vendas.length)===dbv());
await sell(A,1);await A.pg.waitForTimeout(2000);
ok('próxima venda recebe contador+1',maxn()===c1+1&&cnt()===c1+1,maxn()+'/'+cnt());
// ---- S6: venda fiado cita o número definitivo
await A.ev(()=>{});
const fi=await A.ev(()=>{const c=S.clientes[0];return c?c.id:null});
if(fi){await A.pg.fill('#pdv-bar',code);await A.pg.press('#pdv-bar','Enter');await A.pg.waitForTimeout(100);await A.ev((id)=>{},fi);
 await A.pg.selectOption('#pdv-cli',fi);await A.pg.click('[data-act=pdvPag][data-id="Fiado / a prazo"]');await Promise.all([A.pg.click('[data-act=pdvFim]'),sell(B,2)]);await A.pg.waitForTimeout(2500);
 const lid2=await A.ev(()=>LAST.id),ln=await A.ev(()=>LAST.n);
 const dbn2=PSQL(`select (v->>'n') from app_docs d, jsonb_array_elements(d.data->'items') v where d.id like 'vendas-%' and v->>'id'='${lid2}'`);
 const row=PSQL(`select v->>'desc' from app_docs d, jsonb_array_elements(d.data->'items') v where d.id='lancamentos' and v->>'origem'='venda:${lid2}'`);
 const lastn=dbn2;
 ok('LAST.n da tela = número gravado',String(ln)===dbn2,ln+'/'+dbn2);
ok('lançamento do fiado cita o número definitivo da venda',row==='Venda nº '+lastn,row+' / '+lastn)}
ok('nenhum erro de JavaScript nas telas',errs.length===0,errs.join(' | '));
console.log(`\n${pass} passaram, ${fail} falharam`);await b.close();process.exit(fail?1:0)})().catch(e=>{console.log('ERRO',e);process.exit(1)});
