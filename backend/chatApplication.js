'use strict';
/* Chat-only identities and credentials. Message/attachment/history tables remain
 * the existing chatapp tables; no panel roles or passwords are changed. */
const db = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {SECRET, authRequired: panelAuth, requireRole} = require('./auth');
const CODE = /^\d{6}$/;
const stamp = value => crypto.createHmac('sha256',SECRET).update(String(value)).digest('hex');
const systems = ['supervisor', 'support'];
const actorId = (adminId, role) => -2 * Number(adminId) - (role === 'support' ? 1 : 0);
function schema() {
 db.run(`CREATE TABLE IF NOT EXISTS chat_app_codes(user_id INTEGER PRIMARY KEY, hash TEXT, active INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT (datetime('now')))`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_system_identities(actor_id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, identity TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(admin_id,identity))`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_members(conversation_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, PRIMARY KEY(conversation_id,actor_id))`);
 db.run(`CREATE INDEX IF NOT EXISTS idx_chat_members_actor ON chat_members(actor_id,conversation_id)`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_support_groups(owner_id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL UNIQUE, admin_id INTEGER NOT NULL)`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_read_cursors(conversation_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,actor_id))`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_push_subscriptions(endpoint TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, subscription TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
 db.run(`CREATE TABLE IF NOT EXISTS chat_login_attempts(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL)`);
 const cols=db.all('PRAGMA table_info(creator_requests)');
 if(cols.length&&!cols.some(c=>c.name==='chat_code_hash'))db.run('ALTER TABLE creator_requests ADD COLUMN chat_code_hash TEXT');
}
function identity(id) {
 if(id<0){const r=db.get('SELECT s.*,u.username FROM chat_system_identities s JOIN users u ON u.id=s.admin_id WHERE s.actor_id=?',[id]);return r?{id,username:r.username,name:r.identity==='supervisor'?'Supervisor':'Support',role:r.identity}:null;}
 const u=db.get('SELECT id,username,name,role FROM users WHERE id=?',[id]);if(!u)return null;
 return {...u,name:u.role==='admin'?'Admin':((u.role==='manager'?'M ':u.role==='agent'?'A ':'')+(u.name||u.username))};
}
function members(conv) {return conv.kind==='support'?db.all('SELECT actor_id FROM chat_members WHERE conversation_id=?',[conv.id]).map(r=>r.actor_id):[conv.a_id,conv.b_id];}
function access(user, conv) {
 if(!conv)return false;
 if(conv.kind==='support')return members(conv).includes(user.id);
 if(user.id<0)return false;
 return user.role==='admin'||conv.a_id===user.id||conv.b_id===user.id;
}
function ensureSystems(admin) {
 // Initial credentials are supplied via one-time server environment settings.
 // No plaintext credentials are embedded in frontend or ordinary APIs.
 for(const role of systems){const existing=db.get('SELECT actor_id,active FROM chat_system_identities WHERE admin_id=? AND identity=?',[admin.id,role]);if(existing?.active)continue;
  const password=process.env[role==='supervisor'?'CHAT_SUPERVISOR_INITIAL_PASSWORD':'CHAT_SUPPORT_INITIAL_PASSWORD'];
  if(existing&&!password)continue;
  db.run('INSERT INTO chat_system_identities(actor_id,admin_id,identity,hash,active) VALUES(?,?,?,?,?) ON CONFLICT(admin_id,identity) DO UPDATE SET hash=excluded.hash,active=excluded.active',[actorId(admin.id,role),admin.id,role,bcrypt.hashSync(password||crypto.randomBytes(32).toString('hex'),12),password?1:0]);
 }
}
function provision(user) {
 if(!['manager','agent'].includes(user.role))return;
 let parent=db.get('SELECT id,parent_id,role,active FROM users WHERE id=?',[user.id]);const seen=new Set();let admin;
 while(parent&&!seen.has(parent.id)){seen.add(parent.id);if(parent.role==='admin'&&parent.active){admin=parent;break;}parent=parent.parent_id?db.get('SELECT id,parent_id,role,active FROM users WHERE id=?',[parent.parent_id]):null;}
 admin=admin||db.get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
 if(!admin)throw Error('No support administrator configured');
 ensureSystems(admin);
 // Stable group key is its owner, not the names of its participants.
 let group=db.get('SELECT * FROM chat_support_groups WHERE owner_id=?',[user.id]);
 if(!group){db.beginBatch();try{
  db.run("INSERT OR IGNORE INTO chat_conversations(kind,a_id,b_id) VALUES('support',?,?)",[user.id,actorId(admin.id,'support')]);
  const c=db.get("SELECT id FROM chat_conversations WHERE kind='support' AND a_id=? AND b_id=?",[user.id,actorId(admin.id,'support')]);
  db.run('INSERT OR IGNORE INTO chat_support_groups(owner_id,conversation_id,admin_id) VALUES(?,?,?)',[user.id,c.id,admin.id]);
  group=db.get('SELECT * FROM chat_support_groups WHERE owner_id=?',[user.id]);
 }finally{db.endBatch();}}
 for(const id of [user.id,group.admin_id,actorId(group.admin_id,'supervisor'),actorId(group.admin_id,'support')])db.run('INSERT OR IGNORE INTO chat_members(conversation_id,actor_id) VALUES(?,?)',[group.conversation_id,id]);
 if(user.role==='agent'){
  const manager=db.get("SELECT m.id FROM users m JOIN users a ON a.parent_id=m.id WHERE a.id=? AND m.role='manager' AND m.active=1",[user.id]);
  if(manager){const a=Math.min(user.id,manager.id),b=Math.max(user.id,manager.id);db.run("INSERT OR IGNORE INTO chat_conversations(kind,a_id,b_id) VALUES('direct',?,?)",[a,b]);}
 }
}
function validate(decoded) {
 if(decoded.type==='chat_app'){
  if(decoded.id<0){const s=db.get('SELECT s.*,u.active admin_active FROM chat_system_identities s JOIN users u ON u.id=s.admin_id WHERE actor_id=?',[decoded.id]);if(!s||!s.active||!s.admin_active||decoded.credential_version!==stamp(s.hash))throw Error('Revoked');}
  else {const u=db.get('SELECT * FROM users WHERE id=?',[decoded.id]);if(!u||!u.active||!['admin','manager','agent'].includes(u.role))throw Error('Disabled');
   if(u.role!=='admin'){const c=db.get('SELECT * FROM chat_app_codes WHERE user_id=?',[u.id]);if(!c||!c.hash||!c.active||decoded.credential_version!==(stamp(c.version+':'+c.hash)))throw Error('Code revoked');}
  }
 }else{const u=db.get('SELECT active,role FROM users WHERE id=?',[decoded.id]);if(!u||!u.active||!['admin','manager','agent'].includes(u.role)||decoded.type||u.role!=='admin')throw Error('Chat Security Code login required');}
 const who=identity(decoded.id);if(!who)throw Error('Unknown identity');return {...decoded,...who};
}
function auth(req,res,next){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return res.status(401).json({error:'Chat login required'});try{req.user=validate(jwt.verify(h.slice(7),SECRET));next();}catch(e){res.status(401).json({error:'Chat session expired, disabled or revoked. Please log in again.'});}}
function getSetting(key, fallback=''){const r=db.get('SELECT value FROM app_settings WHERE key=?',['chat_app_'+key]);return r?r.value:fallback;}
function setSetting(key,value){db.run("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",['chat_app_'+key,value]);}
function setCode(id,code,active=true){if(!CODE.test(String(code)))throw Error('Code must contain exactly six numeric digits');db.run("INSERT INTO chat_app_codes(user_id,hash,active) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET hash=excluded.hash,active=excluded.active,version=version+1,updated_at=datetime('now')",[id,bcrypt.hashSync(String(code),12),active?1:0]);}
function mount(app,{rateLimit,logAction}){
 const limiter=rateLimit({windowMs:15*60000,max:20,keyFn:req=>'chat-login:'+req.ip});
 app.post('/api/chat-app/login',limiter,(req,res)=>{
  const b=req.body||{},username=String(b.username||'').trim(),password=String(b.password||''),mode=String(b.identity||'user');
  const key=crypto.createHash('sha256').update(username.toLowerCase()).digest('hex'),now=Date.now();
  const lock=db.get('SELECT * FROM chat_login_attempts WHERE key=?',[key]);if(lock&&lock.reset_at>now&&lock.attempts>=10)return res.status(429).json({error:'Too many attempts. Try again in 15 minutes.'});
  const u=db.get('SELECT * FROM users WHERE username=? COLLATE NOCASE',[username]);let who,version;
  if(u&&u.active&&u.role==='admin'&&systems.includes(mode)){ensureSystems(u);const s=db.get('SELECT * FROM chat_system_identities WHERE admin_id=? AND identity=?',[u.id,mode]);if(s&&s.active&&bcrypt.compareSync(password,s.hash)){who=identity(s.actor_id);version=stamp(s.hash);}}
  else if(mode==='user'&&u&&u.active&&['admin','manager','agent'].includes(u.role)){
   if(u.role==='admin'&&bcrypt.compareSync(password,u.password))who=identity(u.id);
   if(u.role!=='admin'){const c=db.get('SELECT * FROM chat_app_codes WHERE user_id=?',[u.id]);if(c&&c.hash&&c.active&&CODE.test(password)&&bcrypt.compareSync(password,c.hash)){who=identity(u.id);version=stamp(c.version+':'+c.hash);}}
  }
  if(!who){if(!u)bcrypt.compareSync(password,'$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');db.run('INSERT INTO chat_login_attempts(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END',[key,now+15*60000,now,now]);return res.status(401).json({error:'Invalid credentials or chat access is not active.'});}
  db.run('DELETE FROM chat_login_attempts WHERE key=?',[key]);provision(who);
  const token=jwt.sign({...who,type:'chat_app',credential_version:version},SECRET,{expiresIn:'12h'});res.set('Cache-Control','no-store').json({token,user:who});
 });
 app.get('/api/chat-app/me',auth,(req,res)=>{provision(req.user);res.set('Cache-Control','no-store').json(req.user);});
 const admin=[panelAuth,requireRole('admin'),(req,res,next)=>{const u=db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",[req.user.id]);if(!u)return res.status(403).json({error:'Active Admin access required'});next();}];
 app.get('/api/chat-app/codes',admin,(req,res)=>res.set('Cache-Control','no-store').json({accounts:db.all("SELECT u.id,u.username,u.name,u.role,CASE WHEN c.hash IS NOT NULL THEN 1 ELSE 0 END configured,COALESCE(c.active,0) active FROM users u LEFT JOIN chat_app_codes c ON c.user_id=u.id WHERE u.role IN ('manager','agent') ORDER BY u.role,u.username")}));
 app.post('/api/chat-app/codes/:id',admin,(req,res)=>{
  const id=Number(req.params.id),u=db.get("SELECT id FROM users WHERE id=? AND role IN ('manager','agent')",[id]);if(!u)return res.status(404).json({error:'Manager or Agent not found'});
  const action=req.body?.action||'set';let generated;
  if(action==='delete')db.run('DELETE FROM chat_app_codes WHERE user_id=?',[id]);
  else if(action==='activate'||action==='deactivate'){const c=db.get('SELECT hash FROM chat_app_codes WHERE user_id=?',[id]);if(!c?.hash)return res.status(400).json({error:'Assign a code first'});db.run('UPDATE chat_app_codes SET active=?,version=version+1 WHERE user_id=?',[action==='activate'?1:0,id]);}
  else if(action==='set'||action==='generate'){generated=action==='generate'?String(crypto.randomInt(0,1000000)).padStart(6,'0'):undefined;const code=generated||String(req.body.code||'');if(!CODE.test(code))return res.status(400).json({error:'Code must contain exactly six numeric digits'});setCode(id,code);}
  else return res.status(400).json({error:'Unknown action'});
  db.run('DELETE FROM chat_push_subscriptions WHERE actor_id=?',[id]);
  logAction(req,'manage_chat_code','chat',{user_id:id,action});res.set('Cache-Control','no-store').json({ok:true,...(generated?{generated_code:generated}:{})});
 });
 app.get('/api/chat-app/config',(req,res)=>res.set('Cache-Control','no-store').json({whatsapp_url:getSetting('whatsapp_url'),update_version:getSetting('update_version'),update_notice:getSetting('update_notice'),push_public_key:process.env.VAPID_PUBLIC_KEY||'',version:'2026.11.12-chat.1'}));
 app.post('/api/chat-app/config',admin,(req,res)=>{
  const b=req.body||{};let url=String(b.whatsapp_url||'').trim();if(url){try{const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='whatsapp.com'||u.port||u.username||u.password||!/^\/channel\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)||u.search||u.hash)throw Error();url=u.href;}catch(e){return res.status(400).json({error:'Use a valid https://whatsapp.com/channel/... URL'});}}
  const version=String(b.update_version||'').trim();if(version&&!/^[0-9A-Za-z._-]{1,64}$/.test(version))return res.status(400).json({error:'Invalid version'});
  setSetting('whatsapp_url',url);setSetting('update_version',version);setSetting('update_notice',String(b.update_notice||'').trim().slice(0,1000));logAction(req,'chat_app_settings','chat',{});res.json({ok:true});
 });
 app.post('/api/chat-app/push/subscribe',auth,(req,res)=>{
  const s=req.body?.subscription;try{const u=new URL(s.endpoint);if(u.protocol!=='https:'||u.port||u.username||u.password||!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))||!(/^[A-Za-z0-9_-]{80,100}$/.test(s.keys?.p256dh||''))||!(/^[A-Za-z0-9_-]{20,30}$/.test(s.keys?.auth||''))||JSON.stringify(s).length>8192)throw Error();}catch(e){return res.status(400).json({error:'Invalid push subscription'});}
  if(!process.env.VAPID_PRIVATE_KEY)return res.status(503).json({error:'Web Push is not configured on this server'});
  if(db.get('SELECT COUNT(*) n FROM chat_push_subscriptions WHERE actor_id=?',[req.user.id]).n>=5)db.run('DELETE FROM chat_push_subscriptions WHERE endpoint=(SELECT endpoint FROM chat_push_subscriptions WHERE actor_id=? ORDER BY updated_at LIMIT 1)',[req.user.id]);
  db.run("INSERT INTO chat_push_subscriptions(endpoint,actor_id,subscription) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET actor_id=excluded.actor_id,subscription=excluded.subscription,updated_at=datetime('now')",[s.endpoint,req.user.id,JSON.stringify(s)]);res.json({ok:true});
 });
 app.post('/api/chat-app/push/unsubscribe',auth,(req,res)=>{db.run('DELETE FROM chat_push_subscriptions WHERE endpoint=? AND actor_id=?',[String(req.body?.endpoint||''),req.user.id]);res.json({ok:true});});
}
async function notify(actor,message){try{if(actor<0){const s=db.get('SELECT s.active,u.active owner_active FROM chat_system_identities s JOIN users u ON u.id=s.admin_id WHERE actor_id=?',[actor]);if(!s?.active||!s.owner_active)return;}else{const u=db.get('SELECT role,active FROM users WHERE id=?',[actor]);if(!u?.active)return;if(u.role!=='admin'){const c=db.get('SELECT active FROM chat_app_codes WHERE user_id=?',[actor]);if(!c?.active)return;}}}catch(_){return;}if(!process.env.VAPID_PRIVATE_KEY||!process.env.VAPID_PUBLIC_KEY)return;try{const webpush=require('web-push');webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@example.com',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);for(const s of db.all('SELECT * FROM chat_push_subscriptions WHERE actor_id=?',[actor])){try{await webpush.sendNotification(JSON.parse(s.subscription),JSON.stringify({id:message.id,conversation_id:message.conversation_id,title:'NEXORA Chat',body:'New message — open Chat to view',url:'/chat-app/?conversation='+message.conversation_id}),{TTL:3600});}catch(e){if(e.statusCode===404||e.statusCode===410)db.run('DELETE FROM chat_push_subscriptions WHERE endpoint=?',[s.endpoint]);}}}catch(e){console.warn('[chat] push delivery failed (details withheld)');}}
function configureSystemIdentity(adminId,role,password){if(!systems.includes(role)||String(password).length<5)throw Error('Invalid system identity/password');const admin=db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",[adminId]);if(!admin)throw Error('Active Admin not found');db.run('INSERT INTO chat_system_identities(actor_id,admin_id,identity,hash,active) VALUES(?,?,?,?,1) ON CONFLICT(admin_id,identity) DO UPDATE SET hash=excluded.hash,active=1',[actorId(adminId,role),adminId,role,bcrypt.hashSync(String(password),12)]);db.run('DELETE FROM chat_push_subscriptions WHERE actor_id=?',[actorId(adminId,role)]);}
module.exports={configureSystemIdentity,schema,identity,members,access,provision,validate,auth,mount,setCode,notify};
