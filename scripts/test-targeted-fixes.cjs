/* Isolated regression tests. Never points at a production database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-regression-'));
const port = 4107, base = `http://127.0.0.1:${port}`;
let server, database;
const results=[];
function ok(name) { results.push(name); console.log('PASS', name); }
async function start() {
  server = spawn(process.execPath, ['backend/server.js'], {cwd:root, env:{...process.env, PORT:String(port), DATA_DIR:data, DB_FILE:path.join(data,'data.sqlite'), CREATOR_UPLOAD_DIR:'', CHAT_UPLOAD_DIR:'', AMS_ROLE:'api', JWT_SECRET:'isolated-regression-secret'}});
  await new Promise((resolve,reject)=>{let log='';const t=setTimeout(()=>reject(Error(log)),15000);server.stdout.on('data',b=>{log+=b;if(log.includes('backend running')){clearTimeout(t);resolve();}});server.stderr.on('data',b=>log+=b);server.on('exit',c=>{clearTimeout(t);reject(Error(log+' exit '+c));});});
}
async function stop() { if(server) {server.kill(); await new Promise(r=>server.once('exit',r));server=null;} }
async function api(url, token, body, expected=200) {
  const headers={};if(token)headers.Authorization='Bearer '+token;
  if(body && !(body instanceof FormData))headers['Content-Type']='application/json';
  const r=await fetch(base+url,{method:body?'POST':'GET',headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  assert.equal(r.status,expected,`${url}: ${await r.clone().text()}`);return r;
}
async function login(username,password) {return (await (await api('/api/login',null,{username,password})).json()).token;}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQAEfgD/WXfuH0AAAAASUVORK5CYII=','base64');
(async()=>{
try {
 await start();
 database=new Database(path.join(data,'data.sqlite'));
 const add=database.prepare('INSERT INTO users(username,password,role,name,parent_id,active) VALUES(?,?,?,?,?,1)');
 const manager=Number(add.run('reg_manager',bcrypt.hashSync('reg-password',10),'manager','Regression Manager',1).lastInsertRowid);
 const agentId=Number(add.run('reg_agent',bcrypt.hashSync('reg-password',10),'agent','Regression Agent',manager).lastInsertRowid);
 add.run('reg_client',bcrypt.hashSync('reg-password',10),'client','Regression Client',agentId);
 const outsider=Number(add.run('reg_outsider',bcrypt.hashSync('reg-password',10),'manager','Unrelated Manager',1).lastInsertRowid);
 const admin=await login('vibepk','vibepk123'), recipientPanel=await login('reg_manager','reg-password');
 await api('/api/chat-app/codes/'+manager,admin,{code:'123456'});await api('/api/chat-app/codes/'+outsider,admin,{code:'654321'});
 const recipient=(await (await api('/api/chat-app/login',null,{username:'reg_manager',password:'123456'})).json()).token,denied=(await (await api('/api/chat-app/login',null,{username:'reg_outsider',password:'654321'})).json()).token;
 for(const t of [admin,recipientPanel]) await api('/api/legal/accept',t,{version:'2026-09-13-v1'});
 await api('/api/login',null,{username:'vibepk',password:'wrong'},401);ok('Login accepts credentials without CAPTCHA and rejects invalid password');
 const form=new FormData();Object.entries({full_name:'Regression Applicant',username:'reg_applicant',email:'reg@example.com',country:'Pakistan',phone_code:'+92',phone:'3001234567',requested_role:'agent',chat_security_code:'987654',cli:'Test',password:'reg-password',confirm_password:'reg-password'}).forEach(([k,v])=>form.append(k,v));form.append('screenshot',new Blob([png],{type:'image/png'}),'proof.png');
 const request=await (await api('/api/creator/register',null,form,201)).json();
 const row=database.prepare('SELECT * FROM creator_requests WHERE id=?').get(request.id);assert(fs.existsSync(path.join(data,'creator-uploads',row.screenshot_path)));ok('Creator screenshot bytes and original request reference persist in DATA_DIR');
 const shot='/api/creator/screenshot/'+request.id;
 let response=await api(shot,admin);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 await api(shot,null,undefined,401);await api(shot,recipient,undefined,403);ok('Only Admin can retrieve actual Creator image');
 database.prepare("UPDATE creator_requests SET screenshot_mime='' WHERE id=?").run(request.id);
 response=await api(shot,admin);assert.equal(response.headers.get('content-type'),'image/png');ok('Legacy Creator row without MIME metadata still returns an image');
 await api('/backend/server.js',null,undefined,404);await api('/backend/creator-uploads/'+row.screenshot_path,null,undefined,404);ok('Project-root static access cannot expose backend or private uploads');
 const conv=(await (await api('/api/chatapp/conversations/open',admin,{user_id:manager})).json()).conversation;
 const convPath='/api/chatapp/conversations/'+conv.id+'/messages';
 const up=new FormData();up.append('file',new Blob([png],{type:'application/octet-stream'}),'chat.png');
 const attachment=(await (await api('/api/chatapp/upload',admin,up)).json()).attachment;assert.equal(attachment.mime,'image/png');
 const sent=await (await api(convPath,admin,{body:'Image caption',attachment_ids:[attachment.id],client_msg_id:'image-regression'})).json();assert.equal(sent.message.attachments.length,1);
 for(const t of [admin,recipient]) {const history=await (await api(convPath,t)).json();assert(history.messages.some(m=>m.id===sent.message.id&&m.attachments[0].id===attachment.id));response=await api(attachment.url,t);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);assert.match(response.headers.get('cache-control'),/no-store/);}
 await api(attachment.url,denied,undefined,403);await api(convPath,denied,undefined,403);ok('Both participants receive persisted image, unrelated user denied');
 await api(convPath,recipient,{body:'',attachment_ids:[attachment.id]},400);ok('Foreign or already-linked attachments cannot silently create empty messages');
 await api(convPath,recipient,{body:'Text regression',attachment_ids:[]});ok('Normal text messaging remains operational');
 database.prepare("UPDATE chat_attachments SET mime='application/octet-stream' WHERE id=?").run(attachment.id);response=await api(attachment.url,recipient);assert.equal(response.headers.get('content-type'),'image/png');ok('Legacy chat MIME repaired on retrieval without altering records');
 const bad=new FormData();bad.append('file',new Blob(['not an image'],{type:'image/png'}),'fake.png');await api('/api/chatapp/upload',admin,bad,400);ok('Fake image bytes rejected');
 await api('/api/logout',recipientPanel,{});const renewed=(await (await api('/api/chat-app/login',null,{username:'reg_manager',password:'123456'})).json()).token;await api(attachment.url,renewed);ok('Image history remains accessible after logout and fresh login');
 await stop();await start();await api(shot,admin);await api(attachment.url,recipient);ok('Creator and chat images remain accessible after backend restart');
 // Optional real Chromium UI checks; install playwright separately to run.
 if(process.env.BROWSER_TESTS==='1') {
 const {chromium}=require('playwright');const browser=await chromium.launch({args:['--no-sandbox']});
 async function pageFor(token,role,name,mobile=false) {const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{});await context.addInitScript(({token,role,name})=>{localStorage.setItem('ams_token',token);localStorage.setItem('ams_role',role);localStorage.setItem('ams_name',name);localStorage.setItem('nx_chat_token',token);},{token,role,name});return context.newPage();}
 const p=await pageFor(admin,'admin','Administrator');await p.goto(base+'/admin');await p.waitForTimeout(800);
 await p.evaluate(()=>showPageByName('requests'));await p.click('[data-shot="'+request.id+'"]');await p.waitForFunction(()=>document.querySelector('#nxrImg')?.naturalWidth>0);ok('Admin actual screenshot decodes inside request modal');await p.reload();await p.evaluate(()=>showPageByName('requests'));await p.click('[data-shot="'+request.id+'"]');await p.waitForFunction(()=>document.querySelector('#nxrImg')?.naturalWidth>0);ok('Admin screenshot preview survives refresh');
 await p.goto(base+'/admin');
 const geometries=[];
 for(const theme of ['light','dark']) {await p.evaluate(theme=>{document.body.classList.remove('ams-light','ams-dark');document.body.classList.add('ams-'+theme);},theme);geometries.push(await p.evaluate(()=>{const side=document.querySelector('.sidebar'),nav=document.querySelector('.sb-nav'),logo=document.querySelector('.sb-logo img');side.scrollTop=100;return {sideWidth:side.clientWidth,navWidth:nav.clientWidth,logoWidth:logo.clientWidth,logoHeight:logo.clientHeight,background:getComputedStyle(logo).backgroundColor,attachment:getComputedStyle(side).backgroundAttachment,navOverflow:getComputedStyle(nav).overflowY,scroll:side.scrollTop};}));}
 assert.deepEqual(geometries[0],geometries[1]);assert.equal(geometries[0].logoWidth,48);assert.equal(geometries[0].background,'rgba(0, 0, 0, 0)');assert(geometries[0].scroll>0);assert.match(geometries[0].attachment,/local/);assert.equal(geometries[0].navOverflow,'visible');ok('Light/dark sidebar geometry and transparent logo match; sidebar owns scrolling');
 await p.evaluate(()=>{document.body.classList.replace('ams-dark','ams-light');showPageByName('cliSearch');});
 const cards=await p.locator('#page-cliSearch .stat-card').evaluateAll(els=>els.map(e=>({heading:getComputedStyle(e.querySelector('h3')).color,label:getComputedStyle(e.querySelector('p')).color,badge:getComputedStyle(e.querySelector('.dash-go')).color})));
 assert(cards.length>=4);for(const c of cards){assert.notEqual(c.heading,'rgb(255, 255, 255)');assert.notEqual(c.label,'rgb(255, 255, 255)');assert.equal(c.badge,'rgb(255, 255, 255)');}ok('CLI Analytics existing cards have readable light-theme labels, numbers and badges');
 for(const role of ['manager','agent','client']) {
 const roleToken=role==='manager'?recipientPanel:await login('reg_'+role,'reg-password');await api('/api/legal/accept',roleToken,{version:'2026-09-13-v1'});
 const panel=await pageFor(roleToken,role,'Regression '+role);await panel.goto(base+'/'+role);await panel.waitForTimeout(300);
 const styles=[];
 for(const theme of ['light','dark']){await panel.evaluate(theme=>{document.body.classList.remove('ams-light','ams-dark');document.body.classList.add('ams-'+theme);},theme);styles.push(await panel.evaluate(()=>{const side=document.querySelector('.sidebar,.rail,.appbar'),logo=side.querySelector('img.ams-sms-logo-img');return {sideWidth:side.clientWidth,logoWidth:logo.clientWidth,logoHeight:logo.clientHeight,background:getComputedStyle(logo).backgroundColor,scroll:getComputedStyle(side).overflowY};}));}
 assert.deepEqual(styles[0],styles[1]);assert.equal(styles[0].logoWidth,48);assert.equal(styles[0].background,'rgba(0, 0, 0, 0)');await panel.close();
 }
 ok('Manager, Agent and Client panels also retain matching sidebar and transparent logo geometry in both themes');
 const other=await pageFor(recipient,'manager','Regression Manager');
 for(const page of [p,other]) {await page.goto(base+'/chat');await page.waitForTimeout(600);await page.locator('[data-key="c'+conv.id+'"]').click();await page.waitForFunction(()=>document.querySelector('.att-img img')?.naturalWidth>0);}
 ok('Sender and recipient render actual chat image in Chromium');
 await p.setInputFiles('#imageInput',{name:'selected.png',mimeType:'image/png',buffer:png});await p.waitForFunction(()=>document.querySelector('.chip-thumb')?.naturalWidth>0);await p.locator('#pending [data-act="rm"]').click();await p.waitForFunction(()=>!document.querySelector('#pending .chip'));ok('Image selection previews before send and can be removed');
 // Generate PNG/JPEG/WEBP with browser canvas so bytes really decode.
 for(const [mime,ext] of [['image/png','png'],['image/jpeg','jpg'],['image/webp','webp']]) {
 const bytes=await p.evaluate(mime=>{const c=document.createElement('canvas');c.width=160;c.height=80;const x=c.getContext('2d');x.fillStyle='#1260de';x.fillRect(0,0,160,80);return [...Uint8Array.from(atob(c.toDataURL(mime).split(',')[1]),c=>c.charCodeAt(0))];},mime);
 const before=await p.locator('.att-img').count();await p.setInputFiles('#imageInput',{name:'picture.'+ext,mimeType:mime,buffer:Buffer.from(bytes)});await p.waitForFunction(()=>document.querySelector('#pending .chip[data-state="ready"]'));await p.click('#btnSend');await p.waitForFunction(n=>[...document.querySelectorAll('.att-img img')].filter(i=>i.naturalWidth>0).length>n,before);await other.waitForFunction(n=>[...document.querySelectorAll('.att-img img')].filter(i=>i.naturalWidth>0).length>n,before);
 }
 ok('PNG, JPG and WEBP send and display on both sides via existing UI');
 await p.evaluate(()=>{const c=document.createElement('canvas');c.width=8;c.height=4;c.toBlob(blob=>{const dt=new DataTransfer();dt.items.add(new File([blob],'clipboard.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});});await p.waitForFunction(()=>document.querySelector('#pending .chip[data-state="ready"]'));await p.click('#btnSend');ok('Clipboard image paste event uploads and sends (synthetic event)');
 await other.reload();await other.waitForTimeout(500);await other.locator('[data-key="c'+conv.id+'"]').click();await other.waitForFunction(()=>[...document.querySelectorAll('.att-img img')].filter(i=>i.naturalWidth>0).length>=4);await other.locator('.att-img').first().click();assert(await other.locator('#imgLight.show').isVisible());ok('Chat image history survives reload and opens larger viewer');
 const mobile=await pageFor(recipient,'manager','Regression Manager',true);await mobile.goto(base+'/chat');await mobile.waitForTimeout(500);if(await mobile.locator('[data-key="c'+conv.id+'"]').isVisible()) await mobile.locator('[data-key="c'+conv.id+'"]').click();await mobile.setInputFiles('#imageInput',{name:'mobile.png',mimeType:'image/png',buffer:png});await mobile.waitForFunction(()=>document.querySelector('#pending .chip[data-state="ready"]'));ok('Mobile-emulated file selection and preview work (not a physical gallery test)');
 await p.goto(base+'/panel-login?source=pwa');await p.waitForURL(/\/admin(?:\/.*)?$/);ok('PWA launch resumes an existing server-validated session');
 const install=await browser.newPage();await install.goto(base+'/panel-login');
 await install.evaluate(()=>{localStorage.removeItem('nx_pwa_dismissed_at');const e=new Event('beforeinstallprompt',{cancelable:true});e.prompt=()=>{window.promptCalled=true;return Promise.resolve();};e.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(e);});
 assert(await install.locator('#nxInstall.show').isVisible());await install.click('#nxInstallGo');assert(await install.evaluate(()=>window.promptCalled));await install.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));assert.equal(await install.locator('#nxInstall.show').count(),0);ok('PWA event wiring invokes prompt and hides installed state (simulated browser events)');
 await install.evaluate(()=>{const e=new Event('beforeinstallprompt',{cancelable:true});e.prompt=()=>Promise.resolve();e.userChoice=Promise.resolve({outcome:'dismissed'});window.dispatchEvent(e);});
 await install.reload();await install.evaluate(()=>{const e=new Event('beforeinstallprompt',{cancelable:true});e.prompt=()=>Promise.resolve();e.userChoice=Promise.resolve({outcome:'dismissed'});window.dispatchEvent(e);});await install.click('#nxInstallGo');await install.waitForFunction(()=>localStorage.getItem('nx_pwa_dismissed_at'));await install.reload();await install.evaluate(()=>window.dispatchEvent(new Event('beforeinstallprompt',{cancelable:true})));assert.equal(await install.locator('#nxInstall.show').count(),0);ok('Dismissed PWA banner stays suppressed on subsequent visit');
 await install.evaluate(()=>navigator.serviceWorker.ready);await install.reload();await install.evaluate(()=>fetch('/api/me',{headers:{Authorization:'Bearer fake'}}));
 const cached=await install.evaluate(async()=>{const found=[];for(const key of await caches.keys()){for(const r of await (await caches.open(key)).keys())found.push(r.url);}return found;});assert(!cached.some(u=>u.includes('/api/')||u.includes('/backend/')||u.includes('/chat')));ok('Service worker registers and does not cache tested API or private image requests');
 const iosContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});const ios=await iosContext.newPage();await ios.goto(base+'/panel-login');await ios.click('#nxInstallGo');assert.match(await ios.locator('#nxInstall').innerText(),/Share[\s\S]*Add to Home Screen[\s\S]*Add/);ok('iOS Safari detection shows Share / Add to Home Screen instructions (UA emulation)');
 await browser.close();
 }
 ok('All requested automated checks completed');
} finally {if(database)database.close();await stop();fs.rmSync(data,{recursive:true,force:true});fs.writeFileSync(path.join(root,'docs','targeted-test-results.json'),JSON.stringify({date:new Date().toISOString(),checks:results},null,2));}
})().catch(e=>{console.error(e);process.exit(1);});
