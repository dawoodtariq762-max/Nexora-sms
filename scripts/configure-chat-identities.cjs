/* Run as the existing app service user from the project root. Passwords are
 * prompted without echo; they never appear in argv, logs, or source files. */
const path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
require('dotenv').config({path:path.join(__dirname,'..','backend','.env')});
const db=require('../backend/db');
const domain=require('../backend/chatApplication');
const readline=require('node:readline');
const {Writable}=require('node:stream');
async function secret(prompt){
 if(!process.stdin.isTTY)throw Error('Use an interactive terminal; refusing non-TTY password input.');
 let muted=false;
 const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
 const rl=readline.createInterface({input:process.stdin,output,terminal:true});
 process.stdout.write(prompt);muted=true;
 const value=await new Promise(resolve=>rl.question('',answer=>resolve(answer)));
 rl.close();process.stdout.write('\n');return value;
}
(async()=>{
 await db.init();domain.schema();
 const username=process.argv[2];if(!username)throw Error('Usage: node scripts/configure-chat-identities.cjs EXISTING_ADMIN_USERNAME');
 const admin=db.get("SELECT id FROM users WHERE username=? COLLATE NOCASE AND role='admin' AND active=1",[username]);if(!admin)throw Error('Active Admin not found in the configured database.');
 for(const role of ['supervisor','support']){const password=await secret(role+' password: ');const confirm=await secret('Confirm '+role+' password: ');if(password!==confirm)throw Error('Passwords did not match.');domain.configureSystemIdentity(admin.id,role,password);console.log(role+' identity configured (hash stored; old Chat sessions revoked).');}
 console.log('Done. Main Admin credentials and panel roles were not changed.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
