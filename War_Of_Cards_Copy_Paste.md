# WAR OF CARDS 1.2.0 — Full-file Copy / Paste

అన్ని source files పూర్తి code. ప్రతి ఫైల్: Delete all old content → Copy full block → Paste → Save.

`public/assets/brand-logo.png` image కూడా ఈ ZIPలో ఉంది; అదే pathలో copy చేయండి. Existing private `.env`, `data/` and `delivery.key` overwrite చేయకండి.

కొత్త install: Node.js 24.xలో `npm run setup`, తర్వాత `npm start`. Customer `/`, Admin `/admin`. Password setup terminalలో వస్తుంది.

Tournament prize breakdown / provisional defaults / reserve funding కోసం TOURNAMENTS.md చదవండి. Wrong Declare = +80 score points and continue the same round. Tournament uses the published rank prizes, not regular 1.8× payout.


## 1. `package.json`

````json
{
  "name": "war-of-cards",
  "version": "1.2.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0 <25"
  },
  "scripts": {
    "setup": "node setup.js",
    "start": "node server.js",
    "dev": "node server.js",
    "test": "node --test test/*.test.js",
    "check": "node --check server.js && node --check game.js && node --check tournaments.js && node --check public/app.js"
  }
}

````


## 2. `.env.example`

````text
PORT=3000
DATA_DIR=./data
# Set BOTH before first launch. No built-in admin password exists.
ADMIN_ID=owner
ADMIN_PASSWORD=ReplaceWithYourOwnLongPassword123!
# Use true only behind your own trusted HTTPS reverse proxy.
TRUST_PROXY=false
NODE_ENV=development
# Optional public support number (digits only). No automatic WhatsApp integration is enabled.
SUPPORT_NUMBER=

````


## 3. `.gitignore`

````text
data/
.env
node_modules/
*.log

````


## 4. `.dockerignore`

````text
.env
data/
node_modules/
.git/
test/
*.log

````


## 5. `setup.js`

````javascript
import { randomBytes } from 'node:crypto';
import { existsSync,writeFileSync } from 'node:fs';
if(existsSync('.env')) {
  console.log('.env already exists. Existing credentials have been kept.');
  process.exit(0);
}
const password='Pr!'+randomBytes(18).toString('base64url');
writeFileSync('.env',`PORT=3000\nDATA_DIR=./data\nADMIN_ID=owner\nADMIN_PASSWORD=${password}\nTRUST_PROXY=false\nNODE_ENV=development\nSUPPORT_NUMBER=\n`,{mode:0o600,flag:'wx'});
console.log('WAR OF CARDS setup complete. Keep these credentials private.');
console.log('Admin ID: owner');
console.log('Admin Password: '+password);
console.log('Run npm start, then open http://localhost:3000/admin');
console.log('The password is used to create the admin only on the first database launch.');

````


## 6. `server.js`

````javascript
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { TABLES, MODES, STAKES, tableById, newGame, fillComputers, startRound, drawCard, discardCard, declareHand, chooseDiscard, chooseTournamentDiscard, nextTurn, activePlayers, finishRound, viewGame, analyze } from './game.js';
import {createTournamentService} from './tournaments.js';

try { process.loadEnvFile(); } catch(e) { if(e.code!=='ENOENT')throw e; }
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.resolve(process.env.DATA_DIR||path.join(ROOT,'data'));
fs.mkdirSync(DATA,{recursive:true,mode:0o700});
const keyPath=path.join(DATA,'delivery.key');
if(!fs.existsSync(keyPath))fs.writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
const secret=fs.readFileSync(keyPath);
const db=new DatabaseSync(path.join(DATA,'play-rummy.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,mobile TEXT,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',blocked INTEGER DEFAULT 0,must_change INTEGER DEFAULT 0,balance INTEGER DEFAULT 0 CHECK(balance>=0),loss_progress INTEGER DEFAULT 0,welcome_used INTEGER DEFAULT 0,promo_used INTEGER DEFAULT 0,created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS signups(id TEXT PRIMARY KEY,token TEXT UNIQUE,name TEXT,mobile TEXT,username TEXT,status TEXT DEFAULT 'pending',delivery TEXT,created INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS pending_username ON signups(username) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS pending_mobile ON signups(mobile) WHERE status='pending';
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER,kind TEXT,note TEXT,ref TEXT UNIQUE,created INTEGER);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),kind TEXT,amount INTEGER,status TEXT DEFAULT 'pending',details TEXT,proof BLOB,mime TEXT,created INTEGER,decided INTEGER);
CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,table_id TEXT,status TEXT,state TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT,details TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS disabled_tables(id TEXT PRIMARY KEY);
`);
const q=(sql,...args)=>db.prepare(sql).get(...args);
const all=(sql,...args)=>db.prepare(sql).all(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const hash=s=>createHash('sha256').update(s).digest('hex');
const now=()=>Date.now();
function tx(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function fail(message,status=400){const e=Error(message);e.status=status;throw e;}
function gameTry(fn){try{return fn();}catch(e){fail(e.message);}}
function passwordHash(p){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;}
function passwordOK(p,stored){try{const [salt,v]=stored.split(':');return timingSafeEqual(Buffer.from(v,'hex'),scryptSync(p,salt,64));}catch{return false;}}
function validPassword(p){if(typeof p!=='string'||p.length<12||p.length>128)fail('Use a password of 12–128 characters.');}
function encrypt(v){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',secret,iv);return Buffer.concat([iv,c.update(v),c.final(),c.getAuthTag()]).toString('base64');}
function decrypt(v){const b=Buffer.from(v,'base64'),c=createDecipheriv('aes-256-gcm',secret,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();}
function audit(actor,action,details){run('INSERT INTO audit VALUES(?,?,?,?,?)',randomUUID(),actor,action,JSON.stringify(details),now());}
const DEFAULTS={welcome:10,promo:10,losing:10,lossThreshold:10000,promoCode:'PLAY10',bankName:'',holderName:'',accountNumber:'',ifsc:'',upi:'',qr:'',support:process.env.SUPPORT_NUMBER||'',minDeposit:100,minWithdrawal:300};
for(const [k,v]of Object.entries(DEFAULTS))run('INSERT OR IGNORE INTO settings VALUES(?,?)',k,JSON.stringify(v));
function settings(){return Object.fromEntries(all('SELECT * FROM settings').map(r=>[r.key,JSON.parse(r.value)]));}
function publicUser(u){return {id:u.id,name:u.name,username:u.username,mobile:u.mobile,role:u.role,balance:u.balance,mustChange:!!u.must_change,blocked:!!u.blocked,lossProgress:u.loss_progress};}
function credit(id,amount,kind,note,ref=randomUUID()) {
  if(!Number.isSafeInteger(amount)||!amount)fail('Invalid ledger amount.');
  if(q('SELECT 1 FROM ledger WHERE ref=?',ref))return false;
  const u=q('SELECT * FROM users WHERE id=?',id);if(!u||u.balance+amount<0)fail('LOW BALANCE');
  run('UPDATE users SET balance=balance+? WHERE id=?',amount,id);
  run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)',randomUUID(),id,amount,kind,note,ref,now());return true;
}
function createUser({name,mobile='',username,password,role='customer',mustChange=true}) {
  if(typeof name!=='string'||name.trim().length<2||name.length>80)fail('Enter a valid name.');
  if(!/^[a-zA-Z0-9_]{4,24}$/.test(username||''))fail('User ID must contain 4–24 letters, digits or underscores.');
  validPassword(password);
  if(q('SELECT 1 FROM users WHERE username=?',username.toLowerCase()))fail('User ID already exists.');
  const id=randomUUID();run('INSERT INTO users(id,name,mobile,username,password,role,must_change,created) VALUES(?,?,?,?,?,?,?,?)',id,name.trim(),mobile,username.toLowerCase(),passwordHash(password),role,Number(mustChange),now());return q('SELECT * FROM users WHERE id=?',id);
}
if(!q("SELECT 1 FROM users WHERE role='admin'")) {
  if(!process.env.ADMIN_ID||!process.env.ADMIN_PASSWORD)throw Error('First launch: set ADMIN_ID and ADMIN_PASSWORD in .env. See README.');
  createUser({name:'Administrator',username:process.env.ADMIN_ID,password:process.env.ADMIN_PASSWORD,role:'admin',mustChange:false});
}
const games=new Map(all("SELECT state FROM games WHERE status!='finished'").map(r=>{const g=JSON.parse(r.state);return[g.id,g];}));
const saveGame=g=>run('INSERT INTO games VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state',g.id,g.tableId,g.status,JSON.stringify(g),g.created);
const findGame=id=>games.get(id)||(()=>{const row=q('SELECT state FROM games WHERE id=?',id);return row?JSON.parse(row.state):null;})();
const tournamentService=createTournamentService({db,credit,tx,audit,games,saveGame});
function roundEnd(g,winner){finishRound(g,winner);if(g.status==='finished'){if(g.tournamentId)tournamentService.recordMatch(g);else settle(g);}saveGame(g);}
function settle(g){
  if(g.settled)return;
  tx(()=>{
    const winner=g.players.find(p=>p.id===g.winnerId);
    for(const p of g.players.filter(p=>!p.bot)) {
      if(g.tie||g.cancelled){credit(p.id,g.stake*100,'refund','Game refunded',`${g.id}:refund:${p.id}`);continue;}
      const won=winner?.id===p.id;
      if(won)credit(p.id,g.stake*180,'game_win','Stake returned + 80% profit',`${g.id}:win:${p.id}`);
      run('UPDATE users SET loss_progress=MAX(0,loss_progress+?) WHERE id=?',won?-g.stake*80:g.stake*100,p.id);
    }
    g.settled=true;saveGame(g);
  });
}
function cancel(g,reason){if(g.tournamentId){tournamentService.cancel(g.tournamentId,reason);return;}g.status='finished';g.cancelled=true;g.log.push(reason);settle(g);saveGame(g);}
let gameCursor=0;
function gameTick() {
  tournamentService.tick();
  const work=[...games.values()],begin=now();let botMoves=0;
  for(let i=0;i<work.length;i++) {const g=work[(gameCursor+i)%work.length];
    try {
      if(g.status==='finished'){games.delete(g.id);continue;}
      if(g.status==='waiting') {
        // Do not add computers to empty rooms. Humans join during the first 10/25 seconds.
        if(now()>=g.deadline-5000&&g.players.length<g.capacity){fillComputers(g);saveGame(g);}
        if(now()>=g.deadline) {
          tx(()=>{for(const p of g.players.filter(p=>!p.bot)){const u=q('SELECT * FROM users WHERE id=?',p.id);if(!u||u.blocked||u.balance<g.stake*100)fail('A player has insufficient balance or is blocked.');credit(p.id,-g.stake*100,'game_stake',`${g.tableId}`,`${g.id}:stake:${p.id}`);}startRound(g);saveGame(g);});
        }
      } else if(g.status==='roundOver'&&now()>=g.deadline){startRound(g);saveGame(g);}
      else if(g.status==='playing') {
        if(g.tournamentId&&now()>=g.hardDeadline){tournamentService.expireMatch(g);continue;}
        const p=g.players[g.turn];
        if((p.bot&&now()>=g.nextBotAt)||(!p.bot&&now()>=g.turnDeadline)) {
          if(p.bot&&g.tournamentId&&now()-begin>80)continue;
          if(!p.drawn)drawCard(g,p,'deck');
          const selected=p.bot?(g.tournamentId?chooseTournamentDiscard(g,p):chooseDiscard(g,p)):p.hand.filter(c=>c.id!==p.pickedDiscard).at(-1).id;
          const won=discardCard(g,p,selected);
          g.log.push(`${p.name}${p.bot?' (Computer)':''} ${p.bot?'played':'timed out; auto-discarded'}.`);
          if(won)roundEnd(g,p.id);else{nextTurn(g);saveGame(g);}if(p.bot)botMoves++;
        }
        if(g.status==='playing'&&g.turns>=200) {
          if(g.tournamentId){tournamentService.expireMatch(g);continue;}
          // Exhaustion is a draw; do not choose a winner or deduct a second stake.
          g.tie=true;g.status='finished';g.log.push('Turn limit reached. All human stakes refunded.');settle(g);saveGame(g);
        }
      }
    } catch(e) {
      // Failed admission has no debit, because admission is atomic. Other faults refund safely.
      if(g.status==='waiting'){g.status='finished';g.cancelled=true;g.settled=true;g.log.push(e.message);saveGame(g);}
      else {console.error('Game recovery',g.id,e.message);cancel(g,'Game interrupted; stakes refunded.');}
    }
  }
  gameCursor=(gameCursor+Math.max(1,botMoves))%Math.max(1,work.length);
}
const ticker=setInterval(gameTick,500);

const rate=new Map();
function limit(key,max=12){const t=now(),old=rate.get(key);const r=old&&old.until>t?old:{count:0,until:t+60000};r.count++;rate.set(key,r);if(r.count>max)fail('Too many attempts. Try again in one minute.',429);}
setInterval(()=>{for(const[k,v]of rate)if(v.until<now())rate.delete(k);run('DELETE FROM sessions WHERE expires<?',now());},60000).unref();
function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1);}
function secure(req){return !!req.socket.encrypted||(process.env.TRUST_PROXY==='true'&&req.headers['x-forwarded-proto']==='https');}
function setCookie(req,res,name,value,age=86400){res.setHeader('Set-Cookie',`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure(req)?'; Secure':''}`);}
function session(req){const token=cookie(req,'pr_session');if(!token)return null;return q('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.blocked=0',hash(token),now());}
function requireUser(req,admin=false,allowChange=false){const u=session(req);if(!u)fail('Please log in.',401);if(admin&&u.role!=='admin')fail('Admin access required.',403);if(u.must_change&&!allowChange)fail('Change your temporary password first.',403);return u;}
function loginSession(req,res,u){const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',hash(token),u.id,now()+86400000);setCookie(req,res,'pr_session',token);}
async function body(req){let size=0,data=[];for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024)fail('Upload is too large.',413);data.push(chunk);}try{const value=JSON.parse(Buffer.concat(data).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))fail('JSON object required.');return value;}catch{fail('Invalid JSON object.');}}
function amount(v,min=1,max=1000000){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||Math.abs(v*100-Math.round(v*100))>0.00001)fail(`Amount must be ₹${min}–₹${max}, with at most two decimals.`);return Math.round(v*100);}
function text(v,max=200){return typeof v==='string'?v.trim().slice(0,max):'';}
function proofInfo(data){if(!data)return{bytes:null,mime:null};const m=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(data);if(!m)fail('Proof must be a PNG or JPEG image.');const b=Buffer.from(m[2],'base64');if(b.length>2*1024*1024)fail('Proof must be less than 2 MB.');if(m[1]==='image/png'&&!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('Invalid PNG.');if(m[1]==='image/jpeg'&&(b[0]!==255||b[1]!==216||b[2]!==255))fail('Invalid JPEG.');return{bytes:b,mime:m[1]};}
function requestView(r){return {...r,proof:undefined,hasProof:!!r.mime,details:JSON.parse(r.details||'{}')};}

async function api(req,res,url) {
  const route=url.pathname,method=req.method;
  if(method!=='GET') {
    if(req.headers['x-play-rummy']!=='1')fail('Missing request verification.',403);
    if(req.headers['sec-fetch-site']==='cross-site')fail('Cross-site request rejected.',403);
    if(req.headers.origin) {
      try{if(new URL(req.headers.origin).host!==req.headers.host)fail('Cross-site request rejected.',403);}catch(e){if(e.status)throw e;fail('Invalid origin.',403);}
    }
    if(!(req.headers['content-type']||'').startsWith('application/json'))fail('JSON required.',415);
  }
  const b=method==='GET'?{}:await body(req);
  if(route==='/api/tournaments'&&method==='GET'){const u=requireUser(req);return tournamentService.list(u.id,url.searchParams.get('date')||'today');}
  if(route==='/api/tournament'&&method==='GET'){const u=requireUser(req);return tournamentService.detail(url.searchParams.get('id'),u.id);}
  if(route==='/api/tournament-book'&&method==='POST'){const u=requireUser(req);limit(`tour-book:${u.id}`,20);return tournamentService.book(b.id,u);}
  if(route==='/api/tournament-cancel-booking'&&method==='POST'){const u=requireUser(req);return tournamentService.unbook(b.id,u);}
  if(route==='/api/admin/tournaments'&&method==='GET'){requireUser(req,true);return tournamentService.adminState();}
  if(route==='/api/admin/tournament-action'&&method==='POST'){const u=requireUser(req,true);return tournamentService.adminAction(b,u.id);}
  if(route==='/api/config'&&method==='GET'){const s=settings();return{modes:MODES,stakes:STAKES,settings:{welcome:s.welcome,promo:s.promo,losing:s.losing,lossThreshold:s.lossThreshold,support:s.support,minDeposit:s.minDeposit,minWithdrawal:s.minWithdrawal},bank:{bankName:s.bankName,holderName:s.holderName,accountNumber:s.accountNumber,ifsc:s.ifsc,upi:s.upi,qr:s.qr}};}
  if(route==='/api/me'&&method==='GET'){const u=session(req);return{user:u?publicUser(u):null};}
  if(route==='/api/login'&&method==='POST') {
    limit(`login:${req.socket.remoteAddress}`);const u=q('SELECT * FROM users WHERE username=?',text(b.username).toLowerCase());
    if(!u||u.blocked||!passwordOK(text(b.password,128),u.password)||(b.admin&&u.role!=='admin')||(!b.admin&&u.role==='admin'))fail('Invalid ID/password or blocked account.',401);
    loginSession(req,res,u);return{user:publicUser(u)};
  }
  if(route==='/api/logout'&&method==='POST'){run('DELETE FROM sessions WHERE token=?',hash(cookie(req,'pr_session')||''));setCookie(req,res,'pr_session','',0);return{ok:true};}
  if(route==='/api/password'&&method==='POST') {
    const u=requireUser(req,false,true);limit(`password:${u.id}`,8);if(!passwordOK(b.current||'',u.password))fail('Current password is incorrect.');validPassword(b.password);
    if(b.password===b.current)fail('Choose a different password.');
    tx(()=>{run('UPDATE users SET password=?,must_change=0 WHERE id=?',passwordHash(b.password),u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);audit(u.id,'change_password',{});});
    const updated=q('SELECT * FROM users WHERE id=?',u.id);loginSession(req,res,updated);return{user:publicUser(updated)};
  }
  if(route==='/api/signup'&&method==='POST') {
    limit(`signup:${req.socket.remoteAddress}`,4);const name=text(b.name,80),mobile=text(b.mobile),username=text(b.username).toLowerCase();
    if(name.length<2||!/^\d{10}$/.test(mobile)||!/^[a-z0-9_]{4,24}$/.test(username))fail('Enter name, a 10-digit mobile and a 4–24 character User ID.');
    if(q('SELECT 1 FROM users WHERE username=?',username)||q("SELECT 1 FROM signups WHERE (username=? OR mobile=?) AND status='pending'",username,mobile))fail('An account or pending request already exists.');
    const id=randomUUID(),token=randomBytes(32).toString('hex');run('INSERT INTO signups(id,token,name,mobile,username,created) VALUES(?,?,?,?,?,?)',id,hash(token),name,mobile,username,now());setCookie(req,res,'pr_signup',token,7*86400);return{id,status:'pending'};
  }
  if(route==='/api/signup-status'&&method==='GET'){const r=q('SELECT id,status,username FROM signups WHERE token=?',hash(cookie(req,'pr_signup')||''));return{request:r||null};}
  if(route==='/api/signup-delivery'&&method==='POST') {
    return tx(()=>{const r=q('SELECT * FROM signups WHERE token=?',hash(cookie(req,'pr_signup')||''));if(!r||r.status!=='approved'||!r.delivery)fail('No unclaimed login details available.',404);const password=decrypt(r.delivery);run('UPDATE signups SET delivery=NULL WHERE id=?',r.id);return{username:r.username,password};});
  }
  if(route==='/api/tables'&&method==='GET') {
    requireUser(req);const disabled=new Set(all('SELECT id FROM disabled_tables').map(x=>x.id));
    return{tables:TABLES.map(t=>{const g=[...games.values()].find(g=>g.tableId===t.id&&g.status!=='finished');return {...t,disabled:disabled.has(t.id),status:g?.status||'ready',occupancy:g?.players.length||0,gameId:g?.id};})};
  }
  if(route==='/api/join'&&method==='POST') {
    const u=requireUser(req);if(u.role!=='customer')fail('Use a customer account to play.',403);limit(`join:${u.id}`,20);
    const t=tableById(b.tableId);if(!t||q('SELECT 1 FROM disabled_tables WHERE id=?',t.id))fail('Table unavailable.');
    const previous=[...games.values()].find(g=>g.status!=='finished'&&g.players.some(p=>p.id===u.id));
    if(previous)return{game:viewGame(previous,u.id)};
    if(u.balance<t.stake*100)fail('LOW BALANCE');
    let g=[...games.values()].find(g=>g.tableId===t.id&&g.status!=='finished');
    if(g&&(g.status!=='waiting'||now()>=g.deadline-5000||g.players.length>=g.capacity))fail('Table is in progress. Choose another table.');
    if(!g){g=newGame(t,u);games.set(g.id,g);}else g.players.push({id:u.id,name:u.name,bot:false,score:0,eliminated:false});saveGame(g);return{game:viewGame(g,u.id)};
  }
  if(route==='/api/game'&&method==='GET') {
    const u=requireUser(req),g=findGame(url.searchParams.get('id'));if(!g||!g.players.some(p=>p.id===u.id))fail('Game not found.',404);return{game:viewGame(g,u.id),user:publicUser(u)};
  }
  if(route==='/api/game-action'&&method==='POST') {
    const u=requireUser(req),g=games.get(b.gameId);if(!g)fail('Game not found.',404);
    const p=g.players.find(p=>p.id===u.id);if(!p)fail('Not your game.',403);
    const actionKey=typeof b.actionId==='string'&&/^[\w-]{8,80}$/.test(b.actionId)?`${u.id}:${b.actionId}`:null;
    if(b.action==='declare'&&!actionKey)fail('A declaration request ID is required.');
    if(actionKey&&g.processedActions?.includes(actionKey))return{game:viewGame(g,u.id),replayed:true};
    if(b.action==='leave'&&g.status==='waiting') {
      g.players=g.players.filter(p=>p.id!==u.id);if(!g.players.some(p=>!p.bot)){g.status='finished';g.cancelled=true;g.settled=true;}saveGame(g);return{left:true};
    }
    if(g.status!=='playing'||p.dropped||p.eliminated)fail('Wait for the next round.');
    if(b.action==='drop') {
      p.dropScore=g.turns===0?20:40;p.dropped=true;p.drawn=false;
      const active=activePlayers(g);
      if(active.length===1)roundEnd(g,active[0].id);else if(g.players[g.turn].id===u.id)nextTurn(g);
      saveGame(g);return{game:viewGame(g,u.id)};
    }
    if(g.players[g.turn].id!==u.id)fail('Wait for your turn.');
    if(b.action==='draw'){if(!['deck','discard'].includes(b.source))fail('Invalid draw source.');gameTry(()=>drawCard(g,p,b.source));}
    else if(b.action==='declare') {
      const result=gameTry(()=>declareHand(g,p,b.cardId));
      g.processedActions=[...(g.processedActions||[]),actionKey];
      if(result.penalty){saveGame(g);return{game:viewGame(g,u.id),penalty:80,message:'Wrong declaration: +80 points. Continue playing this round.'};}
      roundEnd(g,p.id);
    }
    else if(b.action==='discard') {
      if(gameTry(()=>discardCard(g,p,b.cardId)))roundEnd(g,p.id);else nextTurn(g);
    } else fail('Unknown game action.');
    saveGame(g);return{game:viewGame(g,u.id)};
  }
  if(route==='/api/my-games'&&method==='GET') {
    const u=requireUser(req);const rows=all("SELECT g.state FROM games g WHERE EXISTS(SELECT 1 FROM json_each(json_extract(g.state,'$.players')) WHERE json_extract(value,'$.id')=?) ORDER BY g.created DESC LIMIT 100",u.id).map(r=>JSON.parse(r.state));
    return{games:rows.map(g=>({id:g.id,tableId:g.tableId,mode:g.mode,stake:g.stake,status:g.status,created:g.created,won:g.winnerId===u.id,tie:!!g.tie,cancelled:!!g.cancelled,round:g.round}))};
  }
  if(route==='/api/wallet'&&method==='GET') {
    const u=requireUser(req);return{user:publicUser(u),ledger:all('SELECT * FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 100',u.id),requests:all('SELECT * FROM requests WHERE user_id=? ORDER BY created DESC LIMIT 50',u.id).map(requestView)};
  }
  if(route==='/api/request'&&method==='POST') {
    const u=requireUser(req);if(u.role!=='customer')fail('Customer account required.',403);limit(`requests:${u.id}`,8);const s=settings();
    if(!['deposit','withdrawal'].includes(b.kind))fail('Unknown request.');
    const a=amount(b.amount,b.kind==='deposit'?s.minDeposit:s.minWithdrawal);const details={};let proof={bytes:null,mime:null};
    if(b.kind==='deposit') {
      details.utr=text(b.utr,40);details.promo=text(b.promo,30).toUpperCase();
      if(!/^[a-zA-Z0-9-]{6,40}$/.test(details.utr))fail('Enter a valid UTR/reference.');proof=proofInfo(b.proof);if(!proof.bytes)fail('Upload payment proof.');
      if(q("SELECT 1 FROM requests WHERE kind='deposit' AND json_extract(details,'$.utr')=?",details.utr))fail('UTR already submitted.');
    } else {
      for(const k of ['holderName','bankName','accountNumber','ifsc'])details[k]=text(b[k],80);
      if(details.holderName.length<2||details.bankName.length<2||!/^\d{9,18}$/.test(details.accountNumber)||! /^[A-Z]{4}0[A-Z0-9]{6}$/.test(details.ifsc))fail('Check your bank details.');
      if(!passwordOK(b.password||'',u.password))fail('Confirm with your login password.');
      if([...games.values()].some(g=>g.status!=='finished'&&g.players.some(p=>p.id===u.id)))fail('Finish or leave your game before withdrawing.');
    }
    const id=randomUUID();tx(()=>{if(b.kind==='withdrawal')credit(u.id,-a,'withdrawal_hold','Withdrawal request held',`${id}:hold`);run('INSERT INTO requests(id,user_id,kind,amount,details,proof,mime,created) VALUES(?,?,?,?,?,?,?,?)',id,u.id,b.kind,a,JSON.stringify(details),proof.bytes,proof.mime,now());});return{id,status:'pending'};
  }
  if(route==='/api/claim-losing'&&method==='POST') {
    const u=requireUser(req),s=settings(),threshold=s.lossThreshold*100;
    tx(()=>{const fresh=q('SELECT * FROM users WHERE id=?',u.id);if(fresh.loss_progress<threshold)fail('Loss threshold has not been reached.');run('UPDATE users SET loss_progress=loss_progress-? WHERE id=?',threshold,u.id);credit(u.id,Math.round(threshold*s.losing/100),'losing_bonus','Losing bonus claimed');});return{ok:true};
  }
  if(route.startsWith('/api/proof/')&&method==='GET') {
    const u=requireUser(req),id=route.split('/').at(-1),r=q('SELECT * FROM requests WHERE id=?',id);
    if(!r||!r.proof||(u.role!=='admin'&&u.id!==r.user_id))fail('Not found.',404);
    res.writeHead(200,{'Content-Type':r.mime,'Content-Disposition':'inline','Cache-Control':'no-store'});res.end(Buffer.from(r.proof));return null;
  }
  if(route.startsWith('/api/admin/')) {
    const admin=requireUser(req,true);
    if(route==='/api/admin/state'&&method==='GET')return{
      customers:all("SELECT * FROM users WHERE role='customer' ORDER BY created DESC").map(publicUser),
      signups:all('SELECT id,name,mobile,username,status,created FROM signups ORDER BY created DESC LIMIT 200'),
      requests:all('SELECT r.*,u.name,u.username FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.created DESC LIMIT 300').map(requestView),
      ledger:all('SELECT l.*,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created DESC LIMIT 300'),
      audit:all('SELECT * FROM audit ORDER BY created DESC LIMIT 200'),settings:settings(),
      activeGames:[...games.values()].map(g=>({id:g.id,tableId:g.tableId,status:g.status,round:g.round,players:g.players.map(p=>({name:p.name,bot:p.bot,score:p.score}))})),disabledTables:all('SELECT id FROM disabled_tables').map(x=>x.id)
    };
    if(route==='/api/admin/create-user'&&method==='POST') {
      const u=tx(()=>{const u=createUser(b);audit(admin.id,'create_user',{userId:u.id});return u;});return{user:publicUser(u)};
    }
    if(route==='/api/admin/signup'&&method==='POST') {
      return tx(()=>{const r=q('SELECT * FROM signups WHERE id=?',b.id);if(!r||r.status!=='pending')fail('Request already handled.');
        if(b.reject){run("UPDATE signups SET status='rejected' WHERE id=?",r.id);audit(admin.id,'reject_signup',{id:r.id});return{ok:true};}
        const password=`Pr!${randomBytes(12).toString('base64url')}`;
        const u=createUser({name:r.name,mobile:r.mobile,username:r.username,password});run("UPDATE signups SET status='approved',delivery=? WHERE id=?",encrypt(password),r.id);audit(admin.id,'approve_signup',{id:r.id,userId:u.id});return{ok:true};});
    }
    if(route==='/api/admin/customer'&&method==='POST') {
      const u=q("SELECT * FROM users WHERE id=? AND role='customer'",b.id);if(!u)fail('Customer not found.',404);
      tx(()=>{if(b.action==='block'){run('UPDATE users SET blocked=? WHERE id=?',b.blocked?1:0,u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);}
        else if(b.action==='reset'){validPassword(b.password);run('UPDATE users SET password=?,must_change=1 WHERE id=?',passwordHash(b.password),u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);}
        else if(b.action==='balance'){
          const delta=amount(b.amount);if(!['add','remove'].includes(b.direction))fail('Choose add/remove.');if(!text(b.note))fail('Enter a reason.');credit(u.id,b.direction==='remove'?-delta:delta,'admin_adjustment',text(b.note));
        }else fail('Unknown action.');audit(admin.id,b.action,{userId:u.id,amount:b.amount,direction:b.direction,blocked:b.blocked,note:text(b.note)});
      });return{ok:true};
    }
    if(route==='/api/admin/decide'&&method==='POST') {
      tx(()=>{const r=q('SELECT * FROM requests WHERE id=?',b.id);if(!r||r.status!=='pending')fail('Request already processed.');
        if(!['approve','reject'].includes(b.decision))fail('Choose approve or reject.');
        if(b.decision==='approve'&&r.kind==='deposit') {
          credit(r.user_id,r.amount,'deposit','Deposit approved',`${r.id}:deposit`);const u=q('SELECT * FROM users WHERE id=?',r.user_id),s=settings(),d=JSON.parse(r.details);
          if(!u.welcome_used){const bonus=Math.round(r.amount*s.welcome/100);if(bonus)credit(u.id,bonus,'welcome_bonus','Welcome bonus',`${r.id}:welcome`);run('UPDATE users SET welcome_used=1 WHERE id=?',u.id);}
          if(!u.promo_used&&s.promoCode&&d.promo===s.promoCode.toUpperCase()){const bonus=Math.round(r.amount*s.promo/100);if(bonus)credit(u.id,bonus,'promo_bonus','Promo code bonus',`${r.id}:promo`);run('UPDATE users SET promo_used=1 WHERE id=?',u.id);}
        }
        if(b.decision==='reject'&&r.kind==='withdrawal')credit(r.user_id,r.amount,'withdrawal_refund','Rejected withdrawal restored',`${r.id}:restore`);
        run('UPDATE requests SET status=?,decided=? WHERE id=?',b.decision==='approve'?'approved':'rejected',now(),r.id);audit(admin.id,'decide_request',{id:r.id,decision:b.decision});
      });return{ok:true};
    }
    if(route==='/api/admin/settings'&&method==='POST') {
      const s=settings(),clean={};for(const k of Object.keys(DEFAULTS))if(k in b) {
        if(['welcome','promo','losing'].includes(k)){if(typeof b[k]!=='number'||b[k]<0||b[k]>100)fail('Bonus must be 0–100%.');clean[k]=b[k];}
        else if(['lossThreshold','minDeposit','minWithdrawal'].includes(k)){amount(b[k],1);clean[k]=b[k];}
        else if(k==='qr'){if(b[k])proofInfo(b[k]);clean[k]=b[k]||'';}
        else clean[k]=text(b[k],200);
      }
      tx(()=>{for(const[k,v]of Object.entries({...s,...clean}))run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(v),k);audit(admin.id,'settings',{keys:Object.keys(clean)});});return{ok:true};
    }
    if(route==='/api/admin/table'&&method==='POST') {
      if(!tableById(b.tableId))fail('Invalid table.');if(b.disabled)run('INSERT OR IGNORE INTO disabled_tables VALUES(?)',b.tableId);else run('DELETE FROM disabled_tables WHERE id=?',b.tableId);audit(admin.id,'table_toggle',{tableId:b.tableId,disabled:!!b.disabled});return{ok:true};
    }
    if(route==='/api/admin/cancel-game'&&method==='POST'){const g=games.get(b.gameId);if(!g)fail('Game not found.');if(g.status==='waiting'){g.status='finished';g.settled=true;g.cancelled=true;saveGame(g);}else cancel(g,'Cancelled by admin; stakes refunded.');audit(admin.id,'cancel_game',{gameId:g.id});return{ok:true};}
  }
  fail('Not found.',404);
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      res.setHeader('Cache-Control','no-store');const result=await api(req,res,url);if(result!==null&&!res.writableEnded){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));}return;
    }
    if(!['GET','HEAD'].includes(req.method))fail('Method not allowed.',405);
    const requested=decodeURIComponent(url.pathname);
    const file=requested==='/'||requested==='/admin'?path.join(ROOT,'public/index.html'):path.resolve(ROOT,'public','.'+requested);
    if(!file.startsWith(path.join(ROOT,'public')+path.sep))fail('Not found.',404);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())fail('Not found.',404);
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
  }catch(e){if(!res.headersSent){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'Server error. Please retry.'}));}else res.end();if(!e.status)console.error(e);}
});
const portArg=process.argv.indexOf('--port');
server.listen(Number(portArg>=0?process.argv[portArg+1]:process.env.PORT)||3000,'0.0.0.0',()=>console.log(`WAR OF CARDS ready on port ${server.address().port}. Admin route: /admin`));
function shutdown(){clearInterval(ticker);server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

````


## 7. `game.js`

````javascript
import { randomInt, randomUUID } from 'node:crypto';

export const STAKES = [10, 20, 50, 100, 250, 500, 1000, 2000];
export const MODES = [
  { id: 'point101', name: 'Point Rummy', sub: '101', limit: 101 },
  { id: 'point201', name: 'Point Rummy', sub: '201', limit: 201 },
  { id: 'pool', name: 'Pool Rummy', sub: '101 Pool', limit: 101 },
  { id: 'deals', name: 'Deal Rummy', sub: '2 Deals', deals: 2 },
];
export const BOT_NAMES = (() => {
  const first = ['Aarav','Arjun','Aditya','Akash','Amit','Anil','Anand','Ashwin','Bharat','Deepak','Dinesh','Gopal','Hari','Karan','Kiran','Krishna','Manoj','Mohan','Naveen','Nikhil','Prakash','Rahul','Rajesh','Ravi','Rohit','Sachin','Sanjay','Satish','Shiva','Suresh','Tarun','Varun','Venkat','Vijay','Vinay','Vivek','Yash','Abdul','Imran','Irfan','Kabir','Rohan','Sahil','Sameer','Suraj','Tejas','Vishal','Arun','Dev','Rakesh','Aditi','Ananya','Anjali','Anusha','Aparna','Bhavana','Deepa','Divya','Geetha','Harini','Ishita','Jyoti','Kavya','Keerthi','Lakshmi','Madhavi','Meena','Megha','Nandini','Neha','Nisha','Pallavi','Pooja','Priya','Radha','Rani','Rekha','Ritika','Sahana','Sakshi','Sandhya','Sangeeta','Shreya','Sneha','Soumya','Sruthi','Sujatha','Swathi','Tanvi','Uma','Vaishnavi','Vidya','Yamini','Zoya','Ayesha','Farah','Sana','Sara','Nazia','Noor'];
  const last = ['Reddy','Rao','Sharma','Patel','Kumar','Singh','Verma','Das','Nair','Iyer','Joshi','Mehta','Shah','Rathore','Naidu','Pillai','Bose','Bhat','Kapoor','Kulkarni'];
  return first.flatMap(a => last.map(b => `${a} ${b}`));
})();

export function catalog() {
  return MODES.flatMap(m => STAKES.flatMap(stake => [2,6].flatMap(capacity =>
    Array.from({length:5}, (_,i) => ({ id:`${m.id}-${stake}-${capacity}-${i+1}`, mode:m.id, stake, capacity, label:`T${i+1}` }))
  )));
}
export const TABLES = catalog();
export const tableById = id => TABLES.find(t => t.id === id);
export function shuffledDeck() {
  const cards = [];
  for (let d=0;d<2;d++) {
    for (const suit of ['S','H','D','C']) for(let rank=1;rank<=13;rank++) cards.push({id:`${d}-${suit}-${rank}`,suit,rank});
    for(let j=0;j<2;j++) cards.push({id:`${d}-J-${j}`,suit:'J',rank:0});
  }
  for(let i=cards.length-1;i>0;i--) { const j=randomInt(i+1); [cards[i],cards[j]]=[cards[j],cards[i]]; }
  return cards;
}
export const points = (card,wild) => card.rank===0||card.rank===wild?0:Math.min(10,card.rank);
function consecutive(ranks) {
  const a=[...ranks].sort((a,b)=>a-b);
  return a.every((x,i)=>!i||x===a[i-1]+1);
}
function sequence(cards, wild, pure) {
  if(cards.length<3) return false;
  const natural=pure?cards:cards.filter(c=>c.rank!==0&&c.rank!==wild);
  if(natural.some(c=>c.rank===0)||!natural.length) return false;
  if(natural.some(c=>c.suit!==natural[0].suit)) return false;
  const ranks=natural.map(c=>c.rank);
  if(new Set(ranks).size!==ranks.length) return false;
  if(pure) return consecutive(ranks)||consecutive(ranks.map(x=>x===1?14:x));
  const jokers=cards.length-natural.length;
  return [ranks,ranks.map(x=>x===1?14:x)].some(a=> {
    a=a.sort((a,b)=>a-b);
    return a.at(-1)-a[0]+1-a.length<=jokers && cards.length<=13;
  });
}
export function meldType(cards,wild) {
  if(cards.length<3) return null;
  if(sequence(cards,wild,true)) return 'pure';
  if(sequence(cards,wild,false)) return 'sequence';
  if(cards.length>4) return null;
  const natural=cards.filter(c=>c.rank!==0&&c.rank!==wild);
  if(natural.length && natural.every(c=>c.rank===natural[0].rank) && new Set(natural.map(c=>c.suit)).size===natural.length) return 'set';
  return null;
}
// A winning 13-card hand needs at least two sequences, including a pure sequence.
export function analyze(hand,wild) {
  const n=hand.length, full=(1<<n)-1, melds=[];
  for(let mask=1;mask<=full;mask++) {
    let count=0; for(let m=mask;m;m&=m-1) count++;
    if(count<3) continue;
    const cards=hand.filter((_,i)=>mask&(1<<i));
    const type=meldType(cards,wild);
    if(type) melds.push({mask,type,cards:cards.map(c=>c.id),value:cards.reduce((a,c)=>a+points(c,wild),0)});
  }
  const memo=new Map();
  function solve(mask,pure,seq) {
    if(!mask) return pure&&seq>=2?[]:null;
    const key=`${mask}:${pure}:${seq}`;
    if(memo.has(key)) return memo.get(key);
    const bit=mask&-mask;
    for(const m of melds) if((m.mask&bit)&&(mask&m.mask)===m.mask) {
      const rest=solve(mask^m.mask,pure||m.type==='pure',Math.min(2,seq+(m.type!=='set'?1:0)));
      if(rest) { const r=[m,...rest];memo.set(key,r);return r; }
    }
    memo.set(key,null);return null;
  }
  const groups=hand.length===13?solve(full,false,0):null;
  // Deadwood counts only valid sequences until two sequences including a pure are present.
  const states=new Map([['0:0:0',{mask:0,pure:0,seq:0,value:0,groups:[]}]]);
  for(const meld of melds) {
    for(const s of [...states.values()]) if(!(s.mask&meld.mask)) {
      const pure=s.pure||Number(meld.type==='pure'), seq=Math.min(2,s.seq+Number(meld.type!=='set'));
      const ns={mask:s.mask|meld.mask,pure,seq,value:s.value+meld.value,groups:[...s.groups,meld]};
      const key=`${ns.mask}:${pure}:${seq}`;
      if(!states.has(key)) states.set(key,ns);
    }
  }
  const total=hand.reduce((a,c)=>a+points(c,wild),0);
  let protectedValue=0,best=[];
  for(const s of states.values()) if(s.pure) {
    const value=s.seq>=2?s.value:s.groups.filter(g=>g.type==='pure').reduce((a,g)=>a+g.value,0);
    if(value>protectedValue){protectedValue=value;best=s.groups;}
  }
  return { valid:!!groups, groups:groups||best, score:groups?0:Math.min(80,total-protectedValue) };
}
export function newGame(table,user,now=Date.now()) {
  return {id:randomUUID(),tableId:table.id,mode:table.mode,stake:table.stake,capacity:table.capacity,label:table.label,status:'waiting',created:now,deadline:now+(table.capacity===2?15000:30000),players:[{id:user.id,name:user.name,bot:false,score:0,eliminated:false}],log:['Waiting for players. Computer seats are clearly labelled.'],round:0,turns:0};
}
export function fillComputers(game) {
  const used=new Set(game.players.map(p=>p.name));
  while(game.players.length<game.capacity) {
    let name;do{name=BOT_NAMES[randomInt(BOT_NAMES.length)];}while(used.has(name));used.add(name);
    game.players.push({id:`bot-${randomUUID()}`,name,bot:true,score:0,eliminated:false});
  }
}
export function startRound(game,now=Date.now()) {
  game.deck=shuffledDeck();game.indicator=game.deck.pop();game.wild=game.indicator.rank||1;
  game.round++;game.turns=0;
  for(const p of game.players){p.hand=[];p.dropped=!!p.eliminated;p.drawn=false;p.penaltyThisRound=0;if(!p.eliminated)for(let i=0;i<13;i++)p.hand.push(game.deck.pop());}
  game.discard=[game.deck.pop()];game.turn=game.players.findIndex(p=>!p.eliminated);
  game.status='playing';game.turnDeadline=now+30000;game.nextBotAt=now+2500;
  game.log.push(`Round ${game.round} started. Wild rank: ${game.wild}.`);
}
export function activePlayers(game){return game.players.filter(p=>!p.eliminated&&!p.dropped);}
export function nextTurn(game,now=Date.now()) {
  for(let i=0;i<game.players.length;i++) {game.turn=(game.turn+1)%game.players.length;if(!game.players[game.turn].eliminated&&!game.players[game.turn].dropped)break;}
  game.turnDeadline=now+30000;game.nextBotAt=now+2500;game.turns++;
}
export function drawCard(game,player,source) {
  if(player.drawn) throw Error('Discard a card before drawing again.');
  if(source==='discard') {
    const top=game.discard.at(-1);
    if(!top||top.rank===0||top.rank===game.wild)throw Error('A joker cannot be picked from the discard pile.');
    player.hand.push(game.discard.pop());player.pickedDiscard=top.id;
  } else {
    if(!game.deck.length) {
      const top=game.discard.pop();game.deck=game.discard;
      for(let i=game.deck.length-1;i>0;i--){const j=randomInt(i+1);[game.deck[i],game.deck[j]]=[game.deck[j],game.deck[i]];}
      game.discard=top?[top]:[];
    }
    if(!game.deck.length)throw Error('No cards remain.');
    player.hand.push(game.deck.pop());
  }
  player.drawn=true;
}
export function discardCard(game,player,id,declare=false) {
  if(!player.drawn)throw Error('Draw a card first.');
  const i=player.hand.findIndex(c=>c.id===id);
  if(i<0)throw Error('Select one of your cards.');
  if(player.pickedDiscard===id)throw Error('You cannot immediately return the card picked from the discard pile.');
  const remaining=player.hand.filter(c=>c.id!==id);
  const result=analyze(remaining,game.wild);
  if(declare&&!result.valid)throw Error('Invalid declaration. You need two sequences, including one pure sequence, and all 13 cards grouped.');
  game.discard.push(player.hand.splice(i,1)[0]);player.drawn=false;delete player.pickedDiscard;
  return result.valid;
}
// A wrong Show adds points immediately, without dropping the player, discarding
// the selected card, advancing the turn, or resetting the turn clock.
export function declareHand(game,player,id) {
  if(game.status!=='playing'||player.dropped||player.eliminated)throw Error('Player is not active.');
  if(game.players[game.turn]?.id!==player.id)throw Error('Wait for your turn.');
  if(!player.drawn)throw Error('Draw a card first.');
  if(!player.hand.some(c=>c.id===id))throw Error('Select one of your cards.');
  if(player.pickedDiscard===id)throw Error('You cannot immediately return the card picked from the discard pile.');
  const result=analyze(player.hand.filter(c=>c.id!==id),game.wild);
  if(!result.valid) {
    player.score+=80;
    player.penaltyThisRound=(player.penaltyThisRound||0)+80;
    game.log.push(`${player.name}: wrong declaration, +80 points. Continues in this round.`);
    game.log=game.log.slice(-30);
    return {valid:false,penalty:80};
  }
  discardCard(game,player,id,true);
  return {valid:true,penalty:0};
}
export function chooseDiscard(game,player) {
  const choices=player.hand.filter(c=>c.id!==player.pickedDiscard).map(c=>({card:c,...analyze(player.hand.filter(x=>x.id!==c.id),game.wild)}));
  choices.sort((a,b)=>Number(b.valid)-Number(a.valid)||a.score-b.score||points(b.card,game.wild)-points(a.card,game.wild));
  return choices[0].card.id;
}
// Lightweight strategy for large tournament fields; uses ONLY the bot's hand.
export function chooseTournamentDiscard(game,player){
  const natural=player.hand.filter(c=>c.rank!==0&&c.rank!==game.wild);
  const choices=player.hand.filter(c=>c.id!==player.pickedDiscard).map(c=>{
    if(c.rank===0||c.rank===game.wild)return{card:c,keep:1000};
    const sameRank=natural.filter(x=>x.id!==c.id&&x.rank===c.rank&&x.suit!==c.suit).length;
    const near=natural.filter(x=>x.id!==c.id&&x.suit===c.suit&&Math.abs(x.rank-c.rank)===1).length;
    const gap=natural.filter(x=>x.id!==c.id&&x.suit===c.suit&&Math.abs(x.rank-c.rank)===2).length;
    return{card:c,keep:sameRank*12+near*17+gap*5-points(c,game.wild)};
  });choices.sort((a,b)=>a.keep-b.keep);return choices[0].card.id;
}
export function finishRound(game,winnerId,now=Date.now()) {
  const winner=game.players.find(p=>p.id===winnerId);
  for(const p of game.players) if(!p.eliminated) {
    p.roundScore=p.id===winnerId?0:p.dropped?(p.dropScore||40):analyze(p.hand,game.wild).score;
    p.score+=p.roundScore;
  }
  game.log.push(`${winner.name}${winner.bot?' (Computer)':''} won round ${game.round}.`);
  if(game.tournamentId){game.winnerId=winnerId;game.status='finished';return;}
  const mode=MODES.find(m=>m.id===game.mode);
  if(mode.deals) {
    if(game.round>=mode.deals) {
      const sorted=[...game.players].sort((a,b)=>a.score-b.score);
      const tied=sorted.filter(p=>p.score===sorted[0].score);
      game.winnerId=tied.length===1?tied[0].id:null;game.status='finished';game.tie=tied.length>1;
    }
  } else {
    for(const p of game.players)if(p.score>=mode.limit)p.eliminated=true;
    const survivors=game.players.filter(p=>!p.eliminated);
    if(survivors.length<=1){game.winnerId=survivors[0]?.id||winnerId;game.status='finished';}
  }
  if(game.status!=='finished'){game.status='roundOver';game.deadline=now+8000;}
  game.log=game.log.slice(-30);
}
export function viewGame(game,userId) {
  return {...game,deck:undefined,deckCount:game.deck?.length||0,discard:game.discard?.slice(-1)||[],players:game.players.map(p=>({...p,hand:p.id===userId?p.hand:undefined,cardCount:p.hand?.length||0})),log:game.log.slice(-10)};
}

````


## 8. `tournaments.js`

````javascript
import {randomInt,randomUUID} from 'node:crypto';
import {BOT_NAMES,startRound,analyze} from './game.js';
export const IST=19800000,DAY=86400000,HOURS=[6,9,12,15,18,21];
export const DEFAULT_TOURNAMENTS=[
  {id:'classic100',name:'Classic 100',fee:1000,capacity:100,prizes:[50000,25000,10000,5000,1000,1000,1000,1000,1000,1000],rounds:3,roundMinutes:8},
  {id:'mega1000',name:'Mega 1000',fee:1000,capacity:1000,prizes:[500000,250000,100000,10000,10000,10000,10000,10000,10000,10000],rounds:3,roundMinutes:8},
  {id:'starter100',name:'Starter 100',fee:100,capacity:100,prizes:[5000,2500,1000,100,100,100,100,100,100,100],rounds:3,roundMinutes:8}
];
export const localDay=t=>Math.floor((t+IST)/DAY);
export const dayName=d=>new Date(d*DAY).toISOString().slice(0,10);
export const slotStart=(day,hour)=>day*DAY-IST+hour*3600000;
export function validateTemplate(t){
  if(!t||!DEFAULT_TOURNAMENTS.some(x=>x.id===t.id))throw Error('Unknown tournament template.');
  if(typeof t.name!=='string'||t.name.length<2||t.name.length>50)throw Error('Enter a tournament name.');
  if(!Number.isInteger(t.fee)||t.fee<1||t.fee>100000)throw Error('Entry must be a whole rupee, 1–100000.');
  if(![100,1000].includes(t.capacity))throw Error('Choose 100 or 1000 seats.');
  if(!Array.isArray(t.prizes)||t.prizes.length!==10||t.prizes.some(n=>!Number.isInteger(n)||n<0||n>10000000))throw Error('Enter ten non-negative whole-rupee prizes.');
  if(t.prizes.reduce((a,b)=>a+b,0)<=0)throw Error('Prize pool must be positive.');
  if(!Number.isInteger(t.rounds)||t.rounds<1||t.rounds>5||!Number.isInteger(t.roundMinutes)||t.roundMinutes<1||t.roundMinutes>20)throw Error('Use 1–5 rounds and 1–20 minutes per round.');
  return {...t};
}
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
// Split tied prize positions instead of choosing a random winner.
export function rankEntries(entries,prizes){
  const sorted=[...entries].sort((a,b)=>a.score-b.score||a.id.localeCompare(b.id)),out=[];
  for(let i=0;i<sorted.length;){let end=i+1;while(end<sorted.length&&sorted[end].score===sorted[i].score)end++;
    const pool=Array.from({length:end-i},(_,k)=>(prizes[i+k]||0)*100).reduce((a,b)=>a+b,0),base=Math.floor(pool/(end-i)),rem=pool%(end-i);
    for(let j=i;j<end;j++)out.push({...sorted[j],rank:i+1,prize:base+(j-i<rem?1:0)});i=end;
  }return out;
}
export function createTournamentService({db,credit,tx,audit,games,saveGame,clock=Date.now}){
  const q=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);
  const error=(m,status=400)=>{const e=Error(m);e.status=status;throw e;};
  db.exec(`CREATE TABLE IF NOT EXISTS tour_templates(id TEXT PRIMARY KEY,config TEXT);
    CREATE TABLE IF NOT EXISTS tour_fund(id INTEGER PRIMARY KEY CHECK(id=1),balance INTEGER NOT NULL CHECK(balance>=0));
    INSERT OR IGNORE INTO tour_fund VALUES(1,0);
    CREATE TABLE IF NOT EXISTS tour_fund_ledger(id TEXT PRIMARY KEY,amount INTEGER,kind TEXT,note TEXT,ref TEXT UNIQUE,created INTEGER);
    CREATE TABLE IF NOT EXISTS tour_events(id TEXT PRIMARY KEY,template_id TEXT,start INTEGER,closes INTEGER,opens INTEGER,status TEXT,config TEXT,round INTEGER DEFAULT 0,reserve INTEGER DEFAULT 0,created INTEGER,reason TEXT);
    CREATE TABLE IF NOT EXISTS tour_entries(id TEXT PRIMARY KEY,event_id TEXT REFERENCES tour_events(id),user_id TEXT,name TEXT,bot INTEGER,status TEXT,score INTEGER DEFAULT 0,played INTEGER DEFAULT 0,rank INTEGER,prize INTEGER DEFAULT 0,created INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS tour_one_entry ON tour_entries(event_id,user_id) WHERE status!='cancelled';
    CREATE TABLE IF NOT EXISTS tour_matches(id TEXT PRIMARY KEY,event_id TEXT REFERENCES tour_events(id),round INTEGER,number INTEGER,status TEXT,UNIQUE(event_id,round,number));`);
  for(const c of DEFAULT_TOURNAMENTS)run('INSERT OR IGNORE INTO tour_templates VALUES(?,?)',c.id,JSON.stringify(c));
  const config=e=>JSON.parse(e.config),entries=id=>all("SELECT * FROM tour_entries WHERE event_id=? AND status!='cancelled'",id);
  function fund(amount,kind,note,ref){if(q('SELECT 1 FROM tour_fund_ledger WHERE ref=?',ref))return;const b=q('SELECT balance FROM tour_fund WHERE id=1').balance;if(!Number.isSafeInteger(amount)||b+amount<0)error('Insufficient tournament prize reserve.');run('UPDATE tour_fund SET balance=balance+? WHERE id=1',amount);run('INSERT INTO tour_fund_ledger VALUES(?,?,?,?,?,?)',randomUUID(),amount,kind,note,ref,clock());}
  function ensureSchedule(){const day=localDay(clock());for(const d of [day,day+1])for(const h of HOURS)for(const r of all('SELECT * FROM tour_templates')){
    const id=`${dayName(d)}-${h}-${r.id}`,start=slotStart(d,h);
    run("INSERT OR IGNORE INTO tour_events(id,template_id,start,closes,opens,status,config,created) VALUES(?,?,?,?,?,'scheduled',?,?)",id,r.id,start,start-600000,slotStart(d-1,0),r.config,clock());
  }}
  function eventView(e,userId){const list=entries(e.id),c=config(e),mine=list.find(x=>x.user_id===userId&&!x.bot);
    const active=mine?q("SELECT g.id FROM tour_matches m JOIN games g ON g.id=m.id WHERE m.event_id=? AND m.status='playing' AND EXISTS(SELECT 1 FROM json_each(json_extract(g.state,'$.players')) WHERE json_extract(value,'$.id')=?) LIMIT 1",e.id,userId):null;
    return {...c,id:e.id,templateId:c.id,start:e.start,closes:e.closes,opens:e.opens,status:e.status,round:e.round,reserve:e.reserve,reason:e.reason,totalPrize:c.prizes.reduce((a,b)=>a+b,0),joined:list.length,humanCount:list.filter(x=>!x.bot).length,computerCount:list.filter(x=>x.bot).length,mine:mine?{entryId:mine.id,score:mine.score,played:mine.played,rank:mine.rank,prize:mine.prize,gameId:active?.id}:null};
  }
  function list(userId,date='today'){ensureSchedule();const day=localDay(clock())+(date==='tomorrow'?1:0),start=slotStart(day,0),end=start+DAY;
    return {serverNow:clock(),timeZone:'Asia/Kolkata',hours:HOURS,date:dayName(day),events:all('SELECT * FROM tour_events WHERE start>=? AND start<? ORDER BY start,template_id',start,end).map(e=>eventView(e,userId))};
  }
  function detail(id,userId){const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e)error('Tournament not found.',404);const rows=entries(id);return{event:eventView(e,userId),leaderboard:rows.sort((a,b)=>(a.rank||99999)-(b.rank||99999)||a.score-b.score||a.id.localeCompare(b.id)).slice(0,1000).map(x=>({name:x.name,bot:!!x.bot,score:x.score,played:x.played,rank:x.rank,prize:x.prize,mine:x.user_id===userId})),matches:all('SELECT round,number,status FROM tour_matches WHERE event_id=? ORDER BY round,number',id)};}
  function book(id,user){ensureSchedule();return tx(()=>{const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e)error('Tournament not found.',404);if(user.role!=='customer')error('Customer account required.',403);if(clock()<e.opens||clock()>=e.closes||e.status!=='open')error('Registration is closed or prizes have not been funded.');
    const existing=q("SELECT * FROM tour_entries WHERE event_id=? AND user_id=? AND status!='cancelled'",id,user.id);if(existing)return{entryId:existing.id,alreadyBooked:true};
    if(q("SELECT 1 FROM tour_entries p JOIN tour_events e ON e.id=p.event_id WHERE p.user_id=? AND p.bot=0 AND p.status!='cancelled' AND e.start=? AND e.status IN ('open','locked','running')",user.id,e.start))error('You already booked another tournament at this time.');
    const c=config(e);if(entries(id).length>=c.capacity)error('Tournament is full.');
    const entryId=randomUUID();credit(user.id,-c.fee*100,'tournament_entry',`${c.name} · ${id}`,`${entryId}:entry`);
    run("INSERT INTO tour_entries(id,event_id,user_id,name,bot,status,created) VALUES(?,?,?,?,0,'registered',?)",entryId,id,user.id,user.name,clock());return{entryId};});}
  function unbook(id,user){return tx(()=>{const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e||clock()>=e.closes||e.status!=='open')error('Booking cancellation closes ten minutes before start.');const p=q("SELECT * FROM tour_entries WHERE event_id=? AND user_id=? AND bot=0 AND status='registered'",id,user.id);if(!p)error('No active booking.');credit(user.id,config(e).fee*100,'tournament_refund','Tournament booking cancelled',`${p.id}:refund`);run("UPDATE tour_entries SET status='cancelled' WHERE id=?",p.id);return{ok:true};});}
  function cancel(id,reason='Cancelled by admin'){
    const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e||['finished','cancelled'].includes(e.status))return;
    const active=all("SELECT id FROM tour_matches WHERE event_id=? AND status='playing'",id);
    tx(()=>{const fresh=q('SELECT * FROM tour_events WHERE id=?',id);if(['finished','cancelled'].includes(fresh.status))return;
      for(const p of entries(id).filter(p=>!p.bot))credit(p.user_id,config(fresh).fee*100,'tournament_refund',reason,`${p.id}:refund`);
      if(fresh.reserve)fund(fresh.reserve,'reserve_return',reason,`${id}:cancel-reserve`);
      run("UPDATE tour_entries SET status='cancelled' WHERE event_id=?",id);run("UPDATE tour_events SET status='cancelled',reserve=0,reason=? WHERE id=?",reason,id);
      for(const m of active){const row=q('SELECT state FROM games WHERE id=?',m.id);if(row){const g=JSON.parse(row.state);g.status='finished';g.cancelled=true;g.settled=true;g.tournamentCancelled=true;g.log.push(reason);saveGame(g);}}
      run("UPDATE tour_matches SET status='cancelled' WHERE event_id=? AND status='playing'",id);
    });for(const m of active)games.delete(m.id);
  }
  function lock(id){const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e||!['open','scheduled'].includes(e.status))return;const humans=entries(id).filter(p=>!p.bot);if(!humans.length){cancel(id,'No human registrations');return;}
    if(!e.reserve){cancel(id,'Prize pool was not funded');return;}
    tx(()=>{const c=config(e),list=entries(id),used=new Set(list.map(x=>x.name)),names=shuffle(BOT_NAMES).filter(n=>!used.has(n));
      for(let i=list.length;i<c.capacity;i++){const botId=`bot-${randomUUID()}`;run("INSERT INTO tour_entries(id,event_id,user_id,name,bot,status,created) VALUES(?,?,?,?,1,'registered',?)",randomUUID(),id,botId,names[i-list.length]||`Computer ${i+1}`,clock());}
      run("UPDATE tour_events SET status='locked' WHERE id=?",id);
    });
  }
  function launchRound(id){const e=q('SELECT * FROM tour_events WHERE id=?',id),c=config(e),round=e.round+1,players=shuffle(entries(id)),pending=[];
    tx(()=>{const fresh=q('SELECT * FROM tour_events WHERE id=?',id);if(!['locked','running'].includes(fresh.status)||fresh.round!==e.round)return;
      if(q("SELECT 1 FROM tour_matches WHERE event_id=? AND status='playing'",id))return;
      // Equal groups, 2–6 seats; no single-player byes at the configured capacities.
      const tables=Math.ceil(players.length/6),base=Math.floor(players.length/tables),extra=players.length%tables;let offset=0;
      for(let i=0;i<tables;i++){const count=base+(i<extra?1:0),seats=players.slice(offset,offset+count);offset+=count;
        const g={id:randomUUID(),tableId:`TOUR-${id}-R${round}-T${i+1}`,mode:'deals',stake:c.fee,capacity:count,label:`T${i+1}`,status:'waiting',created:clock(),deadline:clock(),round:0,turns:0,tournamentId:id,tournamentName:c.name,tournamentRound:round,tournamentRounds:c.rounds,hardDeadline:clock()+c.roundMinutes*60000,log:[`${c.name}: round ${round}/${c.rounds}. Lowest total points ranks first.`],players:seats.map(p=>({id:p.user_id,name:p.name,bot:!!p.bot,score:0,eliminated:false,entryId:p.id}))};
        startRound(g,clock());saveGame(g);run("INSERT INTO tour_matches VALUES(?,?,?,?,'playing')",g.id,id,round,i+1);pending.push(g);
      }run("UPDATE tour_events SET status='running',round=? WHERE id=?",round,id);
    });for(const g of pending)games.set(g.id,g);
  }
  function finishEvent(id){const e=q('SELECT * FROM tour_events WHERE id=?',id);if(!e||e.status!=='running')return;const c=config(e),ranked=rankEntries(entries(id),c.prizes);
    tx(()=>{const fresh=q('SELECT * FROM tour_events WHERE id=?',id);if(fresh.status!=='running')return;
      let paid=0;for(const p of ranked){run('UPDATE tour_entries SET rank=?,prize=? WHERE id=?',p.rank,p.prize,p.id);if(!p.bot&&p.prize){credit(p.user_id,p.prize,'tournament_prize',`${c.name}: rank ${p.rank}`,`${id}:prize:${p.id}`);paid+=p.prize;}}
      const humans=ranked.filter(p=>!p.bot),fees=humans.length*c.fee*100;
      if(paid>fresh.reserve)error('Prize reserve mismatch.');
      fund(fresh.reserve-paid+fees,'tournament_settlement',`${c.name}: ${humans.length} human entries; computer awards remain in reserve`,`${id}:settlement`);
      for(const p of humans)run('UPDATE users SET loss_progress=MAX(0,loss_progress+?) WHERE id=?',c.fee*100-p.prize,p.user_id);
      run("UPDATE tour_entries SET status='finished' WHERE event_id=? AND status!='cancelled'",id);run("UPDATE tour_events SET status='finished',reserve=0 WHERE id=?",id);audit('system','tournament_finished',{id,paid,humanEntries:humans.length});
    });
  }
  function recordMatch(g){if(g.status!=='finished')error('Match is not finished.');const row=q('SELECT * FROM tour_matches WHERE id=?',g.id);if(!row||row.status!=='playing')return;
    tx(()=>{const fresh=q('SELECT status FROM tour_matches WHERE id=?',g.id);if(fresh.status!=='playing')return;for(const p of g.players)run('UPDATE tour_entries SET score=score+?,played=played+1 WHERE id=?',p.score,p.entryId);g.settled=true;saveGame(g);run("UPDATE tour_matches SET status='finished' WHERE id=?",g.id);});
  }
  function expireMatch(g){if(g.status!=='playing')return;for(const p of g.players){const hand=p.drawn?p.hand.slice(0,13):p.hand;p.roundScore=p.dropped?(p.dropScore||40):analyze(hand,g.wild).score;p.score+=p.roundScore;}g.status='finished';g.winnerId=null;g.log.push('Timed round completed. Remaining cards scored.');recordMatch(g);saveGame(g);}
  let lastEnsure=0;
  function tick(){const t=clock();if(t-lastEnsure>60000){ensureSchedule();lastEnsure=t;}
    for(const e of all("SELECT * FROM tour_events WHERE status IN ('scheduled','open','locked','running') AND closes<=?",t)){
      try{if(['scheduled','open'].includes(e.status))lock(e.id);const fresh=q('SELECT * FROM tour_events WHERE id=?',e.id);
        if(fresh.status==='locked'&&t>fresh.start+120000)cancel(e.id,'Server missed the start time; entries refunded');
        else if(fresh.status==='locked'&&t>=fresh.start)launchRound(e.id);
        else if(fresh.status==='running'&&!q("SELECT 1 FROM tour_matches WHERE event_id=? AND status='playing'",e.id)){if(fresh.round>=config(fresh).rounds)finishEvent(e.id);else launchRound(e.id);}
      }catch(err){console.error('Tournament recovery',e.id,err.message);cancel(e.id,'Tournament interrupted; entries refunded');}
    }
  }
  function adminState(){ensureSchedule();const day=slotStart(localDay(clock()),0);return{fund:q('SELECT balance FROM tour_fund WHERE id=1').balance,templates:all('SELECT config FROM tour_templates').map(x=>JSON.parse(x.config)),events:all('SELECT * FROM tour_events WHERE start>=? ORDER BY start,template_id',day).map(e=>eventView(e)),ledger:all('SELECT * FROM tour_fund_ledger ORDER BY created DESC LIMIT 100')};}
  function adminAction(b,actor){if(b.action==='fund-adjust'){if(!Number.isSafeInteger(b.amount)||b.amount===0||Math.abs(b.amount)>100000000000)error('Enter a non-zero amount in paise.');if(typeof b.note!=='string'||b.note.trim().length<3)error('Enter a reason.');tx(()=>{fund(b.amount,'admin_adjustment',b.note.slice(0,200),randomUUID());audit(actor,'tournament_fund',{amount:b.amount,note:b.note});});}
    else if(b.action==='open'){ensureSchedule();tx(()=>{const e=q('SELECT * FROM tour_events WHERE id=?',b.id);if(!e||e.status!=='scheduled'||clock()>=e.closes)error('This event cannot be opened.');const total=config(e).prizes.reduce((a,b)=>a+b,0)*100;fund(-total,'prize_reserve',e.id,`${e.id}:reserve`);run("UPDATE tour_events SET status='open',reserve=? WHERE id=?",total,e.id);audit(actor,'tournament_open',{id:e.id,total});});}
    else if(b.action==='cancel'){cancel(b.id,'Cancelled by admin');audit(actor,'tournament_cancel',{id:b.id});}
    else if(b.action==='template'){let c;try{c=validateTemplate(b.template);}catch(e){error(e.message);}tx(()=>{run('UPDATE tour_templates SET config=? WHERE id=?',JSON.stringify(c),c.id);for(const e of all("SELECT * FROM tour_events WHERE template_id=? AND status='scheduled'",c.id))run('UPDATE tour_events SET config=? WHERE id=?',JSON.stringify(c),e.id);audit(actor,'tournament_template',{id:c.id});});}
    else error('Unknown tournament action.');return{ok:true};
  }
  ensureSchedule();return{list,detail,book,unbook,cancel,tick,recordMatch,expireMatch,adminState,adminAction};
}

````


## 9. `public/index.html`

````html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#050505">
  <meta name="description" content="WAR OF CARDS — Play Rummy, Win Money.">
  <title>WAR OF CARDS — Play Rummy, Win Money</title>
  <link rel="icon" href="/assets/brand-logo.png" type="image/png">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/theme.css">
  <link rel="stylesheet" href="/tournaments.css">
  <script type="module" src="/app.js"></script>
</head>
<body><div id="app"><p class="loading">Loading Play Rummy…</p></div><div id="toast" role="status" aria-live="polite"></div><div id="modal-root"></div></body>
</html>

````


## 10. `public/app.js`

````javascript
const $=s=>document.querySelector(s);
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'₹'+(Number(n||0)/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const date=n=>new Date(n).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'});
const icons={home:'⌂',games:'♠',wallet:'₹',support:'◉',tournaments:'🏆',menu:'☰',back:'←',close:'×',rotate:'⟳',logout:'↪'};
const state={user:null,config:null,page:'home',mode:'point101',tables:[],game:null,selected:null,manual:false,wallet:null,history:[],admin:null,adminTab:'overview',signup:null,delivery:null,modal:null,busy:false,tourDate:'today',tourList:null,tourDetail:null,tourId:null,boardPage:0,tourAdmin:null};
const adminRoute=location.pathname==='/admin';
async function api(url,data){const r=await fetch(url,{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:data===undefined?{}:{'Content-Type':'application/json','X-Play-Rummy':'1'},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok){if(r.status===401&&state.user){state.user=null;state.game=null;state.modal=null;$('#modal-root').innerHTML='';state.page='home';render();}throw Error(v.error||'Request failed.');}return v;}
let toastTimer;
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),5000);}
function button(label,action,extra='',kind='primary'){return `<button class="${kind}" data-action="${action}" ${extra}>${label}</button>`;}
function field(label,name,type='text',value='',extra=''){return `<label>${label}<input name="${name}" type="${type}" value="${E(value)}" ${extra}></label>`;}
function brand(){return `<a class="brand" href="${adminRoute?'/admin':'/'}"><img src="/assets/brand-logo.png" alt="WAR OF CARDS"><span class="brand-wordmark">WAR OF CARDS</span></a>`;}
function heading(kicker,title,sub=''){return `<div class="section-title"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1>${sub?`<p class="muted">${sub}</p>`:''}</div></div>`;}
function cards(){return `<div class="hero-cards" aria-label="Playing cards">${[['10','♥'],['J','♠'],['Q','♥'],['K','♣'],['A','♥']].map(([r,s],i)=>`<div class="hero-card card-${i} ${s==='♥'?'red':''}"><span>${r}<small>${s}</small></span><b>${s}</b><span>${r}<small>${s}</small></span></div>`).join('')}</div>`;}
function header(){
  if(state.user)return `<header class="topbar signed-in"><div class="topbar-inner">${button('☰','menu','','icon-button')}${brand()}<span class="wallet-chip">${money(state.user.balance)}</span><div class="account-actions">${button('Deposit','wallet-deposit','','small primary')}${button('Withdraw','wallet-withdraw','','small wine')}</div></div></header>`;
  return `<header class="topbar"><div class="topbar-inner"><a class="landing-wordmark" href="/">♠ &nbsp; WAR OF CARDS</a><div class="header-right">${button('Log In',adminRoute?'admin-login':'login','','small wine')}${!adminRoute?button('Sign Up','signup','','small gold-button'):''}</div></div></header>`;
}
function nav(){if(!state.user||adminRoute)return'';return `<nav class="bottom-nav" aria-label="Main navigation">${[['lobby','Home','home'],['history','My Games','games'],['tournaments','Tournament','tournaments'],['wallet','Wallet','wallet'],['support','Support','support']].map(([id,l,ic])=>button(`<span>${icons[ic]}</span>${l}`,'nav',`data-page="${id}" aria-current="${state.page===id?'page':'false'}"`,(state.page===id?'nav-item active':'nav-item')+(id==='tournaments'?' tournament-glow':''))).join('')}</nav>`;}
function bonusCards(){const s=state.config.settings;return `<section class="bonuses"><div class="divider-title">BONUS / SPECIAL OFFERS</div><div class="bonus-grid">${[['Welcome Bonus',s.welcome,'welcome'],['Promo Code Bonus',s.promo,'promo'],['Losing Bonus',s.losing,'losing']].map(([name,p,id])=>`<button class="bonus-card" data-action="bonus" data-kind="${id}"><span>${name}</span><strong>${p}%</strong><small>View details ↗</small></button>`).join('')}</div></section>`;}
function home(){return `<main class="landing"><section class="hero"><img class="hero-logo" src="/assets/brand-logo.png" alt="WAR OF CARDS — golden Ace and mounted warriors"><div class="world-badge">WORLD’S FIRST GAME</div><p class="hero-caption">Play Rummy, Win Money</p><div class="hero-actions">${button('LOG IN','login','','wine')}${button('SIGN UP','signup','','gold-button')}</div></section>${signupBox()}${bonusCards()}<section class="games-intro"><div class="divider-title">OUR GAMES</div><div class="intro-grid">${state.config.modes.map((m,i)=>`<button class="intro-card" data-action="login"><span class="suit">${['♠','♥','♣','♦'][i]}</span><div><h3>${E(m.name)}</h3><span>${E(m.sub)}</span></div><b>↗</b></button>`).join('')}</div></section><div class="support-strip">◉ &nbsp; 24/7 Customer Support ${button('Contact Support','support','','link-button')}</div><footer>18+ | Play Responsibly <a href="/admin">Admin</a></footer></main>`;}
function signupBox(){const r=state.signup;if(!r)return'';return `<section class="signup-status panel"><p class="eyebrow">YOUR SIGN UP REQUEST</p><h3>${r.status==='pending'?'Your ID is being prepared':r.status==='approved'?'Your login is ready':'Request declined'}</h3><p>Requested ID: <b>${E(r.username)}</b> · Request ${E(r.id.slice(0,8))}</p>${r.status==='approved'?state.delivery?`<div class="credentials"><p>Login ID: <b>${E(state.delivery.username)}</b></p><p>Temporary Password: <code>${E(state.delivery.password)}</code></p><p class="muted">Save it now. These details can only be revealed once. Change the password at first login.</p>${button('LOG IN','login')}</div>`:button('Reveal login details once','reveal-login'):r.status==='pending'?'<p class="muted">Stay on this browser. The reply will appear here.</p>':'<p class="muted">Contact support for assistance.</p>'}</section>`;}
function lobby(){const s=state.config,m=s.modes.find(m=>m.id===state.mode);return `<main class="app-main lobby-main"><section class="mode-tabs" aria-label="Game mode">${s.modes.map(m=>`<button class="mode-tab ${state.mode===m.id?'selected':''}" data-action="mode" data-mode="${m.id}"><span>${E(m.name)}</span><b>${E(m.sub)}</b></button>`).join('')}</section><div class="lobby-title"><div><h1>${E(m.name+' '+m.sub)}</h1><p>Select a table to join</p></div><span class="pill">80 Tables</span></div><div class="stake-list">${s.stakes.map(stake=>`<section class="stake-panel"><div class="stake-heading"><h2>₹${stake.toLocaleString('en-IN')}</h2><span>10 Tables</span></div>${[2,6].map(cap=>`<div class="seat-group"><h3>${cap} Players</h3><div class="table-grid">${[1,2,3,4,5].map(i=>{const id=`${state.mode}-${stake}-${cap}-${i}`,t=state.tables.find(t=>t.id===id),disabled=t?.disabled||t?.status&&t.status!=='ready'&&t.status!=='waiting',status=t?.disabled?'Paused':t?.status==='playing'||t?.status==='roundOver'?'Playing':t?.occupancy?`${t.occupancy}/${cap} Joined`:'Ready';return `<button class="table-button ${cap===6?'wine':''}" data-action="join" data-id="${id}" title="${E(status)} · ${cap} Players" aria-label="T${i}, ₹${stake}, ${cap} Players, ${E(status)}" ${disabled?'disabled':''}><strong>T${i}</strong></button>`;}).join('')}</div></div>`).join('')}</section>`).join('')}</div></main>`;}
function history(){return `<main class="app-main">${heading('YOUR TABLE JOURNEY','My Games','Active tables and recent results.')}<div class="history-list">${state.history.length?state.history.map(g=>`<article class="history-card"><span class="history-suit">♠</span><div><h3>${E(g.tableId)}</h3><p class="muted">${date(g.created)} · ${money(g.stake*100)} · Round ${g.round||0}</p></div><span class="pill">${g.cancelled?'Refunded':g.status==='finished'?g.tie?'Draw — refunded':g.won?'Won':'Lost':E(g.status)}</span>${button(g.status==='finished'?'View':'Rejoin','rejoin',`data-id="${g.id}"`,'small primary')}</article>`).join(''):'<div class="empty panel"><h2>Your first table awaits</h2><p class="muted">Your games will appear here.</p>'+button('Explore Games','nav','data-page="lobby"')+'</div>'}</div></main>`;}
function wallet(){const w=state.wallet;if(!w)return '<main class="app-main">Loading wallet…</main>';const s=state.config.settings;return `<main class="app-main">${heading('YOUR ACCOUNT','Wallet')}<section class="balance-card"><span>Available Balance</span><strong>${money(w.user.balance)}</strong><div>${button('Deposit','deposit')}${button('Withdraw','withdraw','','wine')}</div></section><section class="panel loss-panel"><div><h3>Losing Bonus ${s.losing}%</h3><p class="muted">Net settled losses: ${money(w.user.lossProgress)} / ${money(s.lossThreshold*100)}</p></div>${button('Claim Bonus','claim-losing',w.user.lossProgress<s.lossThreshold*100?'disabled':'','small primary')}</section><h2>Requests</h2><div class="list">${w.requests.length?w.requests.map(r=>`<article class="list-row"><div><b>${E(r.kind)}</b><small>${date(r.created)}</small></div><strong>${money(r.amount)}</strong><span class="pill">${E(r.status)}</span></article>`).join(''):'<p class="muted">No requests yet.</p>'}</div><h2>Transactions</h2><div class="list">${w.ledger.length?w.ledger.map(l=>`<article class="list-row"><div><b>${E(l.kind.replaceAll('_',' '))}</b><small>${date(l.created)} · ${E(l.note)}</small></div><strong class="${l.amount>0?'positive':''}">${l.amount>0?'+':''}${money(l.amount)}</strong></article>`).join(''):'<p class="muted">No transactions yet.</p>'}</div></main>`;}
function support(){return `<main class="app-main">${heading('HERE TO HELP','Customer Support')}<section class="panel"><h2>24/7 Customer Support</h2>${state.config.settings.support?`<p>Support number: <b>${E(state.config.settings.support)}</b></p>`:'<p class="muted">The administrator has not added a support number yet.</p>'}<p>For account requests, share the first eight characters of your request number. Never share your password.</p>${button('Rules','rules','','wine')}</section></main>`;}
function render(){if(!state.config)return;document.body.classList.toggle('in-game',!!state.game);if(state.game){$('#app').innerHTML=gameScreen();return;}if(adminRoute){$('#app').innerHTML=adminScreen();return;}$('#app').innerHTML=header()+(state.user?({lobby,history,wallet,support,tournaments,tournamentDetail}[state.page]||lobby)():state.page==='support'?support():home())+nav();}
const rank=r=>({1:'A',11:'J',12:'Q',13:'K'}[r]||r);
const suit=s=>({S:'♠',H:'♥',D:'♦',C:'♣',J:'★'}[s]);
function card(c,clickable=false){return `<${clickable?'button':'div'} class="playing-card ${['H','D'].includes(c.suit)?'red':''} ${state.selected===c.id?'chosen':''}" ${clickable?`data-action="select-card" data-id="${E(c.id)}"`:''} aria-label="${c.rank?rank(c.rank)+' '+suit(c.suit):'Joker'}"><span>${c.rank?rank(c.rank):'J'}<small>${suit(c.suit)}</small></span><b>${suit(c.suit)}</b>${c.rank===state.game?.wild?'<i>W</i>':''}</${clickable?'button':'div'}>`;}

function tournaments(){const list=state.tourList;return `<main class="app-main tournament-main">${heading('SIX DAILY START TIMES · IST','Tournaments','06:00 · 09:00 · 12:00 · 15:00 · 18:00 · 21:00')}<div class="tournament-tabs">${button('Today','tour-date','data-date="today"',state.tourDate==='today'?'primary':'ghost')}${button('Tomorrow · Book Ahead','tour-date','data-date="tomorrow"',state.tourDate==='tomorrow'?'primary':'ghost')}</div><p class="muted">Three tournaments start together at every time. Booking closes 10 minutes before start. Empty seats then fill with clearly labelled Computer players.</p>${list?list.events.map(e=>`<article class="tournament-card panel"><div class="tournament-card-top"><div><h2>${E(e.name)}</h2><p>${date(e.start)} IST</p></div><span class="pill">${E(e.status)}</span></div><div class="tournament-numbers"><div><small>Entry</small><b>${money(e.fee*100)}</b></div><div><small>Prize Pool</small><b>${money(e.totalPrize*100)}</b></div><div><small>Seats</small><b>${e.joined}/${e.capacity}</b></div></div><p class="muted">${e.humanCount} Players · ${e.computerCount} Computers · Closes ${date(e.closes)} IST</p>${button(e.mine?'My Booking / Enter':'View / Book','tour-detail',`data-id="${E(e.id)}"`)}${e.mine?'<span class="pill">Booked</span>':''}</article>`).join(''):'Loading tournaments…'}</main>`;}
async function openTournament(id){state.tourId=id;state.boardPage=0;state.tourDetail=await api('/api/tournament?id='+encodeURIComponent(id));state.page='tournamentDetail';render();}
function tournamentDetail(){const d=state.tourDetail;if(!d)return'<main class="app-main">Loading…</main>';const e=d.event,bookable=e.status==='open'&&Date.now()<e.closes,rows=d.leaderboard.slice(state.boardPage*100,(state.boardPage+1)*100);return `<main class="app-main tournament-detail">${button('← Tournaments','nav','data-page="tournaments"','small ghost')}${heading('TOURNAMENT · '+E(e.status),E(e.name),date(e.start)+' IST')}<section class="panel"><div class="tournament-numbers"><div><small>Entry</small><b>${money(e.fee*100)}</b></div><div><small>Seats</small><b>${e.joined}/${e.capacity}</b></div><div><small>Prize Pool</small><b>${money(e.totalPrize*100)}</b></div></div><p>Booking closes: <b>${date(e.closes)} IST</b></p><p>${e.rounds} timed rounds · up to ${e.roundMinutes} minutes each. Lowest total points ranks first. Equal scores split the prizes for the tied ranks.</p><p class="muted">${e.humanCount} real player registrations · ${e.computerCount} labelled Computers. Computer entries do not contribute cash fees. Tournament prizes use the published prize table; the regular 1.8× payout does not apply.</p>${e.reason?'<p>'+E(e.reason)+'</p>':''}${e.mine?`<p class="pill">Booked · Score ${e.mine.score} · ${e.mine.played}/${e.rounds} rounds${e.mine.rank?' · Rank '+e.mine.rank:''}${e.status==='finished'?' · Prize '+money(e.mine.prize):''}</p>${e.mine.gameId?button('ENTER MY TABLE','rejoin',`data-id="${e.mine.gameId}"`):e.status==='running'?'<p>Waiting for your next round table…</p>':''}${bookable?button('Cancel Booking & Refund','tour-unbook',`data-id="${E(e.id)}"`,'wine'):''}`:button(bookable?'BOOK SEAT — '+money(e.fee*100):e.status==='scheduled'?'Awaiting prize funding':'Registration Closed','tour-book',`data-id="${E(e.id)}" ${bookable?'':'disabled'}`)}<p class="muted">Wrong Declare: +80 points, continue the same round.</p></section><h2>Prize Distribution</h2>${table(['Rank','Prize'],e.prizes.map((p,i)=>[String(i+1),money(p*100)]))}<h2>Players / Leaderboard</h2>${table(['Rank','Name','Score','Rounds','Prize'],rows.map(r=>[r.rank||'—',E(r.name)+(r.bot?' <span class="pill">Computer</span>':'')+(r.mine?' (You)':''),r.score,r.played,money(r.prize)]))}<div class="tournament-tabs">${button('Previous','tour-board','data-dir="-1" '+(state.boardPage===0?'disabled':''),'small ghost')}<span>Page ${state.boardPage+1}</span>${button('Next','tour-board','data-dir="1" '+((state.boardPage+1)*100>=d.leaderboard.length?'disabled':''),'small ghost')}</div></main>`;}
function tournamentAdmin(){const a=state.tourAdmin;if(!a)return'Loading…';return `<section class="panel"><h2>Tournament Prize Reserve: ${money(a.fund)}</h2><p class="muted">Reserve the full published prize pool before opening bookings. Computer seats do not provide paid fees. These are app wallet records; bank transfers remain separate.</p><form data-form="tour-fund" class="form-grid">${field('Reserve adjustment (₹; negative removes)','amount','number','','required step="0.01"')}${field('Reason','note','text','','required minlength="3"')}<button>Update Reserve</button><p class="form-message"></p></form></section><section class="panel"><h2>Templates / Prize Tables</h2><p class="muted">Changes apply to unopened events only. Opened events retain their published prize table.</p>${a.templates.map(c=>`<form class="template-form form-grid" data-form="tour-template"><input type="hidden" name="id" value="${c.id}">${field('Name','name','text',c.name,'required')}${field('Entry (₹)','fee','number',c.fee,'required min="1" max="100000"')}<label>Players<select name="capacity"><option value="100" ${c.capacity===100?'selected':''}>100</option><option value="1000" ${c.capacity===1000?'selected':''}>1000</option></select></label>${field('Rounds','rounds','number',c.rounds,'required min="1" max="5"')}${field('Minutes per round','roundMinutes','number',c.roundMinutes,'required min="1" max="20"')}<label class="wide">Ten prizes in rupees, comma separated<input name="prizes" value="${E(c.prizes.join(','))}" required></label><button>Save Template</button><p class="form-message"></p></form>`).join('')}</section><h2>Today / Tomorrow Events</h2>${table(['Start IST / Event','Fee / Seats','Prize Pool','Status','Action'],a.events.map(e=>[date(e.start)+'<small>'+E(e.name)+'</small>',money(e.fee*100)+' / '+e.capacity,money(e.totalPrize*100),E(e.status),e.status==='scheduled'&&Date.now()<e.closes?button('Reserve & Open','tour-admin',`data-id="${E(e.id)}" data-op="open"`,'small primary'):['open','locked','running'].includes(e.status)?button('Cancel & Refund','tour-admin',`data-id="${E(e.id)}" data-op="cancel"`,'small wine'):'—']))}<h2>Reserve Ledger</h2>${table(['Date','Type','Amount','Note'],a.ledger.map(r=>[date(r.created),E(r.kind),money(r.amount),E(r.note)]))}`;}
function gameScreen(){
  const g=state.game,me=g.players.find(p=>p.id===state.user.id),turn=g.players[g.turn],playing=g.status==='playing',mine=playing&&turn?.id===me?.id&&!me?.dropped&&!me?.eliminated,m=g.tournamentId?{name:g.tournamentName,sub:'Round '+g.tournamentRound+'/'+g.tournamentRounds}:state.config.modes.find(m=>m.id===g.mode);
  return `<div class="game-viewport ${state.manual?'manual':''}"><header class="game-top"><div>${button('←','leave-game','aria-label="Back to lobby"','small ghost')}<b class="game-wordmark">WAR OF CARDS</b></div><span>${E(m.name+' '+m.sub)} · ₹${g.stake} · ${E(g.label)}</span><div><span class="wallet-chip">${money(state.user.balance)}</span>${button('⟳','rotate','aria-label="Rotate game"','small wine')}${button('☰','menu','aria-label="Game menu"','small ghost')}</div></header><main class="game-content"><section class="rummy-felt"><div class="felt-brand">WAR OF CARDS</div><div class="opponents ${g.capacity===2?'two-player':''}">${g.players.filter(p=>p.id!==me?.id).map(p=>`<div class="player-seat ${playing&&turn?.id===p.id?'turn':''} ${p.dropped||p.eliminated?'out':''}"><span class="avatar">${E(p.name[0])}</span><div><b>${E(p.name)}</b><small>${p.bot?'Computer · ':''}${p.score} pts${p.penaltyThisRound?' · +'+p.penaltyThisRound+' penalty':''}</small><span class="mini-cards" aria-label="${p.cardCount||0} hidden cards">▧ ▧ ▧ ▧ ▧</span>${p.dropped||p.eliminated?'<small>'+ (p.eliminated?'Eliminated':'Dropped')+'</small>':''}</div></div>`).join('')||'<p class="muted">Waiting for an opponent…</p>'}</div><div class="table-center">${g.status==='waiting'?`<div class="waiting"><h2>Starts in <b data-countdown="${g.deadline}"></b>s</h2><p>${g.players.length}/${g.capacity} seats filled</p><small>Computer seats are labelled. Human window: ${g.capacity===2?10:25}s.</small></div>`:g.status==='finished'?`<div class="result"><h2>${g.cancelled?'Game Refunded':g.tie?'Draw — Refunded':g.tournamentId?'Tournament Round Complete':g.winnerId===me?.id?'You Won!':'Game Finished'}</h2><p>${g.tournamentId?'Prizes are settled after the final tournament ranking.':g.winnerId===me?.id?money(g.stake*180)+' credited to your wallet':E(g.log.at(-1)||'')}</p>${button(g.tournamentId?'Tournament / Next Table':'Back to Lobby','close-game','','small primary')}</div>`:g.status==='roundOver'?`<div class="waiting"><h2>Round ${g.round} complete</h2><p>${E(g.log.at(-1))}</p><p>Next round in <b data-countdown="${g.deadline}"></b>s</p></div>`:`<div class="deck-area"><div><button class="deck-back" data-action="draw" data-source="deck" aria-label="Draw from closed deck" ${!mine||me.drawn?'disabled':''}>♠</button><span class="pile-label">Closed Deck</span></div><div><button class="discard-pile" data-action="draw" data-source="discard" aria-label="Draw from discard pile" ${!mine||me.drawn?'disabled':''}>${g.discard[0]?card(g.discard[0]):''}</button><span class="pile-label">Discard Pile</span></div><div>${g.indicator?card(g.indicator):''}<span class="pile-label">Wild Joker</span></div></div>`}</div><div class="hand-area"><div class="hand-heading"><b>You · ${E(me?.name||'')} <small>${me?.score||0} pts${me?.penaltyThisRound?' · +'+me.penaltyThisRound+' penalty':''}</small></b>${playing?`<span class="turn-timer"><b data-countdown="${g.turnDeadline}"></b>s</span>`:''}</div><div class="hand-cards">${(me?.hand||[]).map(c=>card(c,playing)).join('')||'<p class="muted">Cards are dealt when the countdown ends.</p>'}</div><p class="action-help">${mine?me.drawn?'Select a card — Discard or Declare.':'Your turn — draw a card':playing?E(turn?.name||'')+' is playing.':'Round '+(g.round||0)}</p></div></section><div class="game-actions">${button('SORT','sort-cards','','small primary')}${button('DROP','drop',!playing||me.dropped||me.eliminated?'disabled':'','small wine')}${button('DISCARD','discard',!mine||!me.drawn||!state.selected?'disabled':'','small primary')}${button('DECLARE','declare',!mine||!me.drawn||!state.selected?'disabled':'','small wine')}</div></main></div>`;
}
function adminScreen(){if(!state.user||state.user.role!=='admin')return `<div class="admin-login">${brand()}<p class="eyebrow">ADMINISTRATION</p><h1>Admin Control Panel</h1><p class="muted">Sign in with your separate Admin ID and Password.</p><form data-form="login">${field('Admin ID','username','text','','required autocomplete="username"')}${field('Admin Password','password','password','','required autocomplete="current-password"')}<input type="hidden" name="admin" value="true"><button>Log In</button><p class="form-message" role="alert"></p></form><a href="/">← Customer site</a></div>`;
if(!state.admin)return '<main class="app-main">Loading administration…</main>';
const tabs=[['overview','Overview'],['signups','Sign Up Requests'],['customers','Customers / IDs'],['deposits','Deposit Requests'],['withdrawals','Withdrawals'],['wallet','Coin Management'],['payments','Payment Settings'],['bonuses','Bonus Settings'],['tables','Games / Tables'],['tournaments','Tournaments'],['transactions','Transactions'],['settings','Admin Settings']];
return `<div class="admin-shell"><aside class="admin-sidebar">${brand()}<p class="eyebrow">ADMIN CONTROL PANEL</p><nav>${tabs.map(([id,label])=>button(label,'admin-tab',`data-tab="${id}"`,state.adminTab===id?'admin-nav active':'admin-nav')).join('')}</nav>${button('Logout','logout','','ghost')}</aside><main class="admin-main"><header class="admin-heading"><div><p class="eyebrow">WAR OF CARDS · ADMIN</p><h1>${tabs.find(t=>t[0]===state.adminTab)?.[1]}</h1></div>${button('Refresh','admin-refresh','','small ghost')}</header>${adminContent()}</main></div>`;}
function table(headers,rows){return `<div class="table-scroll"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>'<tr>'+row.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join(''):`<tr><td colspan="${headers.length}">No records yet.</td></tr>`}</tbody></table></div>`;}
function adminContent(){const a=state.admin,s=a.settings,customers=a.customers.map(u=>`<option value="${u.id}">${E(u.username)} — ${E(u.name)}</option>`).join('');switch(state.adminTab){
case 'tournaments':return tournamentAdmin();
case 'overview':return `<div class="stats-grid">${[['Customers',a.customers.length],['Pending Sign Ups',a.signups.filter(r=>r.status==='pending').length],['Pending Deposits',a.requests.filter(r=>r.kind==='deposit'&&r.status==='pending').length],['Pending Withdrawals',a.requests.filter(r=>r.kind==='withdrawal'&&r.status==='pending').length]].map(([l,n])=>`<section class="panel stat"><span>${l}</span><strong>${n}</strong></section>`).join('')}</div><section class="panel"><h2>Account operations</h2><p>Use the left menu to create IDs, review requests and manage balances. Every balance adjustment is recorded.</p><p class="muted">Approving a withdrawal records your decision. Complete the bank transfer separately.</p></section>`;
case 'signups':return table(['Name / Mobile','Requested ID','Status','Action'],a.signups.map(r=>[`${E(r.name)}<small>${E(r.mobile)}</small>`,E(r.username),E(r.status),r.status==='pending'?button('Create & Send ID','approve-signup',`data-id="${r.id}"`,'small primary')+button('Reject','reject-signup',`data-id="${r.id}"`,'small wine'):'—']));
case 'customers':return `<section class="panel"><h2>Create Customer ID</h2><form data-form="create-user" class="form-grid">${field('Full name','name','text','','required')}${field('Mobile','mobile','tel','','pattern="[0-9]{10}"')}${field('User ID','username','text','','required minlength="4" maxlength="24"')}${field('Temporary password','password','password','','required minlength="12"')}<button>Create ID</button><p class="form-message" role="alert"></p></form></section>${table(['Customer','Balance','Status','Actions'],a.customers.map(u=>[`${E(u.name)}<small>${E(u.username)} · ${E(u.mobile)}</small>`,money(u.balance),u.blocked?'Blocked':'Active',button(u.blocked?'Unblock':'Block','block',`data-id="${u.id}" data-blocked="${!u.blocked}"`,'small wine')+button('Reset Password','reset',`data-id="${u.id}"`,'small ghost')]))}`;
case 'wallet':return `<section class="panel"><h2>Add / Remove Balance</h2><form data-form="adjust" class="form-grid"><label>Customer<select name="id" required><option value="">Choose customer</option>${customers}</select></label><label>Action<select name="direction"><option value="add">Add balance</option><option value="remove">Remove balance</option></select></label>${field('Amount (₹)','amount','number','','required min="1" step="0.01"')}${field('Reason','note','text','','required')}<button>Save Adjustment</button><p class="form-message" role="alert"></p></form></section>`;
case 'deposits':case 'withdrawals':return table(['Customer','Amount','Details','Status','Action'],a.requests.filter(r=>r.kind===(state.adminTab==='deposits'?'deposit':'withdrawal')).map(r=>[`${E(r.name)}<small>${E(r.username)}</small>`,money(r.amount),Object.entries(r.details).map(([k,v])=>`${E(k)}: ${E(v)}`).join('<br>')+(r.hasProof?`<br><a href="/api/proof/${r.id}" target="_blank" rel="noopener">View Proof ↗</a>`:''),E(r.status),r.status==='pending'?button('Approve','decide',`data-id="${r.id}" data-decision="approve"`,'small primary')+button('Reject','decide',`data-id="${r.id}" data-decision="reject"`,'small wine'):'—']));
case 'payments':return `<section class="panel"><h2>Bank / UPI / QR</h2><form data-form="payment-settings" class="form-grid">${['bankName','holderName','accountNumber','ifsc','upi','support'].map(k=>field(({bankName:'Bank Name',holderName:'Account Holder',accountNumber:'Account Number',ifsc:'IFSC',upi:'UPI ID',support:'Support Number'})[k],k,'text',s[k])).join('')}<label>Payment QR (PNG/JPEG, max 2 MB)<input type="file" name="qr" accept="image/png,image/jpeg"></label>${s.qr?'<img class="qr" src="'+E(s.qr)+'" alt="Current payment QR">':''}<button>Save Payment Settings</button><p class="form-message" role="alert"></p></form></section>`;
case 'bonuses':return `<section class="panel"><form data-form="bonus-settings" class="form-grid">${field('Welcome Bonus %','welcome','number',s.welcome,'min="0" max="100" required')}${field('Promo Bonus %','promo','number',s.promo,'min="0" max="100" required')}${field('Losing Bonus %','losing','number',s.losing,'min="0" max="100" required')}${field('Losing Threshold (₹)','lossThreshold','number',s.lossThreshold,'min="1" required')}${field('Active Promo Code','promoCode','text',s.promoCode)}${field('Minimum Deposit (₹)','minDeposit','number',s.minDeposit,'min="1" required')}${field('Minimum Withdrawal (₹)','minWithdrawal','number',s.minWithdrawal,'min="1" required')}<button>Save Bonus Settings</button><p class="form-message" role="alert"></p></form><p class="muted">Welcome: first approved deposit. Promo: once per customer. Losing: cumulative net settled losses, one threshold consumed per claim.</p></section>`;
case 'tables':return `<section class="panel"><h2>Pause / Resume Table</h2><form data-form="table-toggle" class="form-grid"><label>Mode<select name="mode">${state.config.modes.map(m=>`<option value="${m.id}">${E(m.name+' '+m.sub)}</option>`).join('')}</select></label><label>Stake<select name="stake">${state.config.stakes.map(s=>`<option>${s}</option>`).join('')}</select></label><label>Players<select name="capacity"><option>2</option><option>6</option></select></label><label>Table<select name="number">${[1,2,3,4,5].map(n=>`<option value="${n}">T${n}</option>`).join('')}</select></label><label>Status<select name="disabled"><option value="true">Paused</option><option value="false">Ready</option></select></label><button>Apply</button><p class="form-message" role="alert"></p></form><p class="muted">Paused tables: ${a.disabledTables.length}. Existing games finish normally.</p></section>${table(['Table','State','Players','Action'],a.activeGames.map(g=>[E(g.tableId),E(g.status),g.players.map(p=>E(p.name)+(p.bot?' (Computer)':'')).join('<br>'),button('Cancel & Refund','cancel-game',`data-id="${g.id}"`,'small wine')]))}`;
case 'transactions':return table(['Date / Customer','Type','Amount','Note'],a.ledger.map(l=>[date(l.created)+'<small>'+E(l.username)+'</small>',E(l.kind),money(l.amount),E(l.note)]));
case 'settings':return `<section class="panel"><h2>Change Admin Password</h2>${passwordForm()}</section><h2>Audit Log</h2>${table(['Date','Action','Details'],a.audit.map(r=>[date(r.created),E(r.action),E(r.details)]))}`;
}}
function passwordForm(){return `<form data-form="password">${field('Current password','current','password','','required autocomplete="current-password"')}${field('New password','password','password','','required minlength="12" autocomplete="new-password"')}${field('Confirm new password','confirm','password','','required minlength="12" autocomplete="new-password"')}<button>Change Password</button><p class="form-message" role="alert"></p></form>`;}
function showModal(title,html){state.modal=title;$('#modal-root').innerHTML=`<div class="modal-shade"><section class="modal" role="dialog" aria-modal="true" aria-label="${E(title)}"><header><h2>${title}</h2>${state.user?.mustChange?'':button('×','close-modal','','icon-button')}</header>${html}</section></div>`;$('#modal-root').querySelector('input,button')?.focus();}
function closeModal(){if(state.user?.mustChange)return;$('#modal-root').innerHTML='';state.modal=null;}
function loginModal(){showModal('Log In',`<form data-form="login">${field('Login ID','username','text','','required autocomplete="username"')}${field('Password','password','password','','required autocomplete="current-password"')}<button>Log In</button><p class="form-message" role="alert"></p></form><p>Need an ID? ${button('Sign Up','signup','','link-button')}</p>`);}
function signupModal(){showModal('Request Your ID',`<p class="muted">Submit your details. Your login will appear in your request box after admin approval.</p><form data-form="signup">${field('Full name','name','text','','required minlength="2" maxlength="80" autocomplete="name"')}${field('Mobile number','mobile','tel','','required pattern="[0-9]{10}" maxlength="10" autocomplete="tel-national"')}${field('Choose User ID','username','text','','required pattern="[a-zA-Z0-9_]{4,24}" autocomplete="username"')}<label class="check"><input type="checkbox" required> I am 18 or older.</label><button>Submit Request</button><p class="form-message" role="alert"></p></form>`);}
async function loadAdmin(){state.admin=await api('/api/admin/state');state.tourAdmin=await api('/api/admin/tournaments');}
async function navigate(page){state.page=page;if(page==='tournaments')state.tourList=await api('/api/tournaments?date='+state.tourDate);if(page==='lobby')state.tables=(await api('/api/tables')).tables;if(page==='history')state.history=(await api('/api/my-games')).games;if(page==='wallet'){state.wallet=await api('/api/wallet');state.user=state.wallet.user;}render();}
async function loadGame(id){state.game=(await api('/api/game?id='+encodeURIComponent(id))).game;state.selected=null;state.manual=matchMedia('(orientation: portrait)').matches;render();}
async function gameAction(action,extra={}){const r=await api('/api/game-action',{gameId:state.game.id,action,actionId:crypto.randomUUID(),...extra});if(r.left){state.game=null;await navigate('lobby');}else{state.game=r.game;if(!r.penalty)state.selected=null;render();if(r.penalty)toast(r.message);}}
function depositModal(){const bank=state.config.bank;showModal('Deposit',`<p>Minimum: ₹${state.config.settings.minDeposit}</p><div class="bank-details">${bank.bankName?`<p>${E(bank.bankName)} · ${E(bank.holderName)}</p><p>Account: ${E(bank.accountNumber)}<br>IFSC: ${E(bank.ifsc)}</p>`:''}${bank.upi?'<p>UPI: <b>'+E(bank.upi)+'</b></p>':''}${bank.qr?'<img class="qr" src="'+E(bank.qr)+'" alt="Payment QR">':''}${!bank.bankName&&!bank.upi&&!bank.qr?'<p class="muted">Payment details have not been configured. Contact admin before sending a payment.</p>':''}</div><form data-form="deposit">${field('Amount (₹)','amount','number','','required min="'+state.config.settings.minDeposit+'" step="0.01"')}${field('UTR / Reference','utr','text','','required minlength="6" maxlength="40"')}${field('Promo code (optional)','promo')}<label>Proof (PNG/JPEG, max 2 MB)<input type="file" name="proof" accept="image/png,image/jpeg" required></label><button>Submit Deposit Request</button><p class="form-message" role="alert"></p></form>`);}
function withdrawModal(){showModal('Withdraw',`<p>Minimum: ₹${state.config.settings.minWithdrawal} · Available ${money(state.user.balance)}</p><form data-form="withdraw">${field('Amount (₹)','amount','number','','required min="'+state.config.settings.minWithdrawal+'" step="0.01"')}${field('Account holder','holderName','text','','required')}${field('Bank name','bankName','text','','required')}${field('Account number','accountNumber','text','','required pattern="[0-9]{9,18}"')}${field('Confirm account number','confirmAccount','text','','required')}${field('IFSC','ifsc','text','','required pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}"')}${field('Confirm login password','password','password','','required autocomplete="current-password"')}<button>Submit Withdrawal Request</button><p class="muted">The amount is held until the admin approves or rejects it.</p><p class="form-message" role="alert"></p></form>`);}
const actions={
'tour-date':async el=>{state.tourDate=el.dataset.date;await navigate('tournaments');},
'tour-detail':el=>openTournament(el.dataset.id),
'tour-board':el=>{state.boardPage+=Number(el.dataset.dir);render();},
'tour-book':el=>{const e=state.tourDetail.event;showModal('Confirm Tournament Booking',`<p>${E(e.name)} · ${money(e.fee*100)} entry</p><p>${date(e.start)} IST. ${e.rounds} timed rounds; computer seats are labelled.</p>${button('Confirm Booking','tour-book-confirm',`data-id="${E(e.id)}"`)}`);},
'tour-book-confirm':async el=>{await api('/api/tournament-book',{id:el.dataset.id});closeModal();state.user=(await api('/api/me')).user;await openTournament(el.dataset.id);toast('Tournament seat booked.');},
'tour-unbook':el=>showModal('Cancel Booking',`<p>Cancel your seat and refund the entry?</p>${button('Confirm Cancellation','tour-unbook-confirm',`data-id="${E(el.dataset.id)}"`,'wine')}`),
'tour-unbook-confirm':async el=>{await api('/api/tournament-cancel-booking',{id:el.dataset.id});closeModal();state.user=(await api('/api/me')).user;await openTournament(el.dataset.id);},
'tour-admin':el=>showModal(el.dataset.op==='open'?'Reserve Prize Pool & Open':'Cancel Tournament',`<p>${el.dataset.op==='open'?'Reserve the full prize pool and open registration?':'Cancel the whole tournament and refund all human entry fees?'}</p>${button('Confirm','tour-admin-confirm',`data-id="${E(el.dataset.id)}" data-op="${el.dataset.op}"`)}`),
'tour-admin-confirm':async el=>{await api('/api/admin/tournament-action',{action:el.dataset.op,id:el.dataset.id});closeModal();await loadAdmin();render();},
login:loginModal,'admin-login':()=>$('#app input')?.focus(),signup:signupModal,'close-modal':closeModal,
support:()=>navigate('support'),nav:el=>navigate(el.dataset.page),mode:el=>{state.mode=el.dataset.mode;render();},
menu:()=>showModal('Account',`<p>${E(state.user.name)} · ${E(state.user.username)}</p><div class="menu-list">${button('Rules','rules','','ghost')}${button('Bonus / Promo Code','bonus','data-kind="promo"','ghost')}${button('Change Password','password','','ghost')}${button('Logout','logout','','wine')}</div>`),
password:()=>showModal('Change Password',passwordForm()),
logout:async()=>{await api('/api/logout',{});state.user=null;state.admin=null;state.game=null;state.page='home';$('#modal-root').innerHTML='';state.modal=null;render();},
'reveal-login':async()=>{state.delivery=await api('/api/signup-delivery',{});render();},
bonus:el=>{const s=state.config.settings,k=el.dataset.kind;showModal(k==='welcome'?'Welcome Bonus':k==='promo'?'Promo Code Bonus':'Losing Bonus',k==='welcome'?`<p>Receive ${s.welcome}% on your first approved deposit.</p>`:k==='promo'?`<p>Enter a valid promo code when submitting your deposit. Receive ${s.promo}% after approval. One promo bonus per customer.</p>`:`<p>After ₹${s.lossThreshold.toLocaleString('en-IN')} in net settled losses, claim ${s.losing}% — ${money(s.lossThreshold*s.losing)}.</p><p>Game profits reduce your loss progress. Each claim consumes one loss threshold.</p>`);},
rules:()=>showModal('Rummy Rules',`<div class="rules"><p>Each player receives 13 cards. On your turn, draw one card, then discard one.</p><p>A valid declaration groups all 13 cards into sequences and sets. You need at least two sequences, including one pure sequence. A sequence has three or more consecutive cards of one suit. A set has three or four equal ranks of different suits.</p><p>Printed jokers and the wild rank substitute in impure sequences and sets. Ace can be low or high; K–A–2 does not wrap. A wild-rank card can be used naturally in a pure sequence.</p><p>101 / 201 tables: penalty points accumulate between rounds; players reaching the limit are eliminated. Pool uses 101. Deals uses two deals; the lowest total score wins. A tied deal result refunds human stakes.</p><p>Turn time: 30 seconds. On timeout, the server draws and discards automatically. Drop penalty: 20 before the first table turn, otherwise 40. Deadwood is capped at 80. A wrong Declare / Show immediately adds 80 points to your score; you remain active in the same round. The turn and cards stay unchanged. Normal discard has no such penalty.</p><p>2 players: 15-second countdown; computers fill empty seats after 10 seconds. 6 players: 30-second countdown; computers fill after 25 seconds. Computer seats are labelled and use their own cards only.</p><p>Entry is debited once when the game starts. A game winner receives 1.8× their own entry, including the returned entry. ₹100 → ₹180 (₹80 profit). This is a fixed payout, including at 6-player tables. Refunds return the entry only.</p></div>`),
'wallet-deposit':async()=>{await navigate('wallet');depositModal();},'wallet-withdraw':async()=>{await navigate('wallet');withdrawModal();},deposit:depositModal,withdraw:withdrawModal,
'claim-losing':async()=>{await api('/api/claim-losing',{});await navigate('wallet');toast('Losing bonus added.');},
join:async el=>{const r=await api('/api/join',{tableId:el.dataset.id});state.game=r.game;state.manual=matchMedia('(orientation: portrait)').matches;render();},rejoin:el=>loadGame(el.dataset.id),
'select-card':el=>{state.selected=state.selected===el.dataset.id?null:el.dataset.id;render();},draw:el=>gameAction('draw',{source:el.dataset.source}),discard:()=>gameAction('discard',{cardId:state.selected}),declare:()=>gameAction('declare',{cardId:state.selected}),drop:()=>showModal('Drop this round?',`<p>You remain in the game series with a drop penalty.</p>${button('Confirm Drop','confirm-drop','','wine')}`),'confirm-drop':async()=>{closeModal();await gameAction('drop');},
'sort-cards':()=>{state.game.players.find(p=>p.id===state.user.id)?.hand?.sort((a,b)=>a.suit.localeCompare(b.suit)||a.rank-b.rank);render();},
'leave-game':async()=>{if(state.game.status==='waiting')return gameAction('leave');const tid=state.game?.tournamentId;state.game=null;state.manual=false;if(tid)return openTournament(tid);await navigate('lobby');},
'close-game':async()=>{const tid=state.game?.tournamentId;state.game=null;state.manual=false;state.user=(await api('/api/me')).user;if(tid)return openTournament(tid);await navigate('lobby');},
rotate:async()=>{if(state.manual){state.manual=false;render();return;}try{await document.documentElement.requestFullscreen();await screen.orientation.lock('landscape');state.manual=false;}catch{state.manual=matchMedia('(orientation: portrait)').matches;toast('Rotate your phone, or use the rotated table view.');}render();},
'admin-tab':el=>{state.adminTab=el.dataset.tab;render();},'admin-refresh':async()=>{await loadAdmin();render();},
'approve-signup':async el=>{await api('/api/admin/signup',{id:el.dataset.id});await loadAdmin();render();toast('ID sent to the customer request box.');},'reject-signup':async el=>{await api('/api/admin/signup',{id:el.dataset.id,reject:true});await loadAdmin();render();},
block:async el=>{await api('/api/admin/customer',{id:el.dataset.id,action:'block',blocked:el.dataset.blocked==='true'});await loadAdmin();render();},
reset:el=>showModal('Reset Customer Password',`<form data-form="reset"><input type="hidden" name="id" value="${el.dataset.id}">${field('New temporary password','password','password','','required minlength="12"')}<button>Reset Password</button><p class="form-message" role="alert"></p></form>`),
decide:el=>showModal('Confirm Request Decision',`<p>${el.dataset.decision==='approve'?'Approve':'Reject'} this request? Withdrawal approval records a decision; transfer the funds separately.</p>${button('Confirm','confirm-decide',`data-id="${el.dataset.id}" data-decision="${el.dataset.decision}"`)}`),
'confirm-decide':async el=>{await api('/api/admin/decide',{id:el.dataset.id,decision:el.dataset.decision});closeModal();await loadAdmin();render();},
'cancel-game':el=>showModal('Cancel Game',`<p>End the game and refund any debited human entries?</p>${button('Cancel & Refund','confirm-cancel',`data-id="${el.dataset.id}"`,'wine')}`),
'confirm-cancel':async el=>{await api('/api/admin/cancel-game',{gameId:el.dataset.id});closeModal();await loadAdmin();render();}
};
document.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el||el.disabled||state.busy)return;const fn=actions[el.dataset.action];if(!fn)return;state.busy=true;try{await fn(el);}catch(err){toast(err.message);}finally{state.busy=false;}});
function fileData(file){return new Promise((resolve,reject)=>{if(!file||!file.size)return resolve('');if(file.size>2*1024*1024)return reject(Error('Image must be less than 2 MB.'));const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not read image.'));r.readAsDataURL(file);});}
document.addEventListener('submit',async e=>{const form=e.target.closest('form[data-form]');if(!form)return;e.preventDefault();if(state.busy)return;const b=Object.fromEntries(new FormData(form)),kind=form.dataset.form,msg=form.querySelector('.form-message'),submit=form.querySelector('button[type="submit"],button:not([type])');state.busy=true;if(submit)submit.disabled=true;try{
if(kind==='tour-fund'){const amount=Math.round(Number(b.amount)*100);if(!Number.isSafeInteger(amount)||amount===0)throw Error('Enter a non-zero amount.');await api('/api/admin/tournament-action',{action:'fund-adjust',amount,note:b.note});await loadAdmin();render();toast('Prize reserve updated.');}
else if(kind==='tour-template'){const template={id:b.id,name:b.name,fee:Number(b.fee),capacity:Number(b.capacity),rounds:Number(b.rounds),roundMinutes:Number(b.roundMinutes),prizes:b.prizes.split(',').map(n=>Number(n.trim()))};await api('/api/admin/tournament-action',{action:'template',template});await loadAdmin();render();toast('Unopened events updated.');}
else if(kind==='login'){const r=await api('/api/login',{username:b.username,password:b.password,admin:b.admin==='true'});state.user=r.user;$('#modal-root').innerHTML='';state.modal=null;if(state.user.mustChange){render();showModal('Change Temporary Password',passwordForm());}else if(adminRoute){await loadAdmin();render();}else await navigate('lobby');}
else if(kind==='signup'){await api('/api/signup',b);state.signup=(await api('/api/signup-status')).request;closeModal();state.page='home';render();toast('Request submitted. Your reply will appear here.');}
else if(kind==='password'){if(b.password!==b.confirm)throw Error('Passwords do not match.');state.user=(await api('/api/password',b)).user;closeModal();if(adminRoute){await loadAdmin();render();}else await navigate('lobby');toast('Password changed.');}
else if(kind==='deposit'){await api('/api/request',{...b,kind:'deposit',amount:Number(b.amount),proof:await fileData(b.proof)});closeModal();await navigate('wallet');toast('Deposit request submitted.');}
else if(kind==='withdraw'){if(b.accountNumber!==b.confirmAccount)throw Error('Account numbers do not match.');await api('/api/request',{...b,kind:'withdrawal',amount:Number(b.amount),ifsc:b.ifsc.toUpperCase()});closeModal();await navigate('wallet');toast('Withdrawal request submitted.');}
else if(kind==='create-user'){await api('/api/admin/create-user',b);await loadAdmin();render();toast('Customer created. Share the temporary password securely.');}
else if(kind==='reset'){await api('/api/admin/customer',{...b,action:'reset'});closeModal();await loadAdmin();render();toast('Password reset. Existing sessions revoked.');}
else if(kind==='adjust'){await api('/api/admin/customer',{...b,action:'balance',amount:Number(b.amount)});await loadAdmin();render();toast('Balance updated.');}
else if(kind==='payment-settings'){const payload={...b};delete payload.qr;if(b.qr?.size)payload.qr=await fileData(b.qr);await api('/api/admin/settings',payload);state.config=await api('/api/config');await loadAdmin();render();toast('Settings saved.');}
else if(kind==='bonus-settings'){for(const k of ['welcome','promo','losing','lossThreshold','minDeposit','minWithdrawal'])b[k]=Number(b[k]);await api('/api/admin/settings',b);state.config=await api('/api/config');await loadAdmin();render();toast('Bonus settings saved.');}
else if(kind==='table-toggle'){await api('/api/admin/table',{tableId:`${b.mode}-${b.stake}-${b.capacity}-${b.number}`,disabled:b.disabled==='true'});await loadAdmin();render();toast('Table updated.');}
}catch(err){if(msg)msg.textContent=err.message;else toast(err.message);}finally{state.busy=false;if(submit)submit.disabled=false;}});
// Keep focus within a modal and allow Escape except during mandatory password change.
document.addEventListener('keydown',e=>{if(!state.modal)return;if(e.key==='Escape')closeModal();if(e.key==='Tab'){const items=[...$('#modal-root').querySelectorAll('button,input,select,a[href]')].filter(el=>!el.disabled);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
matchMedia('(orientation: portrait)').addEventListener('change',()=>{state.manual=false;if(state.game)render();});
setInterval(()=>document.querySelectorAll('[data-countdown]').forEach(el=>el.textContent=Math.max(0,Math.ceil((Number(el.dataset.countdown)-Date.now())/1000))),250);
let polling=false;
setInterval(async()=>{if(polling||state.busy||document.hidden)return;polling=true;try{
if(state.game&&!state.modal){const requestedId=state.game.id;const packet=await api('/api/game?id='+encodeURIComponent(requestedId));const g=packet.game;if(packet.user)state.user=packet.user;if(state.game?.id!==requestedId)return;const before=JSON.stringify(state.game);if(JSON.stringify(g)!==before){const hand=state.game.players.find(p=>p.id===state.user.id)?.hand;const incoming=g.players.find(p=>p.id===state.user.id)?.hand;if(hand&&incoming)incoming.sort((a,b)=>{const ai=hand.findIndex(c=>c.id===a.id),bi=hand.findIndex(c=>c.id===b.id);return(ai<0?999:ai)-(bi<0?999:bi);});state.game=g;if(!incoming?.some(c=>c.id===state.selected))state.selected=null;render();}}
else if(state.user&&!adminRoute&&state.page==='lobby'&&!state.modal&&Date.now()-(state.tableRefresh||0)>5000){state.tableRefresh=Date.now();const tables=(await api('/api/tables')).tables;if(!state.game&&state.page==='lobby'){state.tables=tables;render();}}
else if(state.user&&!adminRoute&&['tournaments','tournamentDetail'].includes(state.page)&&!state.modal&&Date.now()-(state.tourRefresh||0)>4000){state.tourRefresh=Date.now();if(state.page==='tournaments'){state.tourList=await api('/api/tournaments?date='+state.tourDate);}else state.tourDetail=await api('/api/tournament?id='+encodeURIComponent(state.tourId));if(!state.game)render();}
else if(!state.user&&state.signup?.status==='pending'&&!state.modal){const r=(await api('/api/signup-status')).request;if(r?.status!==state.signup.status){state.signup=r;render();}}
}catch(err){toast(err.message);}finally{polling=false;}},1000);
async function init(){try{state.config=await api('/api/config');state.user=(await api('/api/me')).user;if(state.user?.role==='admin'&&!adminRoute){location.replace('/admin');return;}if(state.user&&adminRoute&&state.user.role!=='admin'){state.user=null;}
if(state.user?.mustChange){render();showModal('Change Temporary Password',passwordForm());}
else if(state.user&&adminRoute){await loadAdmin();render();}else if(state.user)await navigate('lobby');else{state.signup=(await api('/api/signup-status')).request;render();}
}catch(err){$('#app').innerHTML='<main class="app-main"><h1>Unable to load</h1><p>'+E(err.message)+'</p></main>';}}
init();

````


## 11. `public/style.css`

````css
@import url('/local-fonts.css');
:root{color-scheme:dark;--bg:#0a070b;--panel:#17101a;--line:#37283e;--muted:#a3b3a9;--green:#6c0b99;--green-dark:#41075d;--wine:#710d2e;--white:#f5f7f4;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;background:var(--bg);color:var(--white)}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button,a,input,select{-webkit-tap-highlight-color:transparent}button{border:1px solid transparent;background:linear-gradient(130deg,#6b0b98,#450762);color:white;border-radius:12px;padding:13px 21px;font-weight:700;cursor:pointer;min-height:46px;transition:filter .15s,transform .15s}button:hover:not(:disabled){filter:brightness(1.15)}button:active:not(:disabled){transform:translateY(1px)}button:disabled{opacity:.4;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid white;outline-offset:3px}a{color:#effbf3;text-underline-offset:4px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(26px,4vw,40px);letter-spacing:-1.3px;margin-bottom:12px}h2{font-size:23px;letter-spacing:-.6px}h3{font-size:18px;margin-bottom:8px}p{line-height:1.6}small{font-size:12px}.muted{color:var(--muted)}.positive{color:#c17ae2}.wine{background:linear-gradient(125deg,#8d103b,#530b24);border-color:#a73457}.ghost{background:transparent;border-color:var(--line)}.small{padding:9px 15px;font-size:14px;min-height:40px}.icon-button{background:transparent;padding:8px 12px;font-size:26px;min-width:44px}.link-button{background:none;color:#c790e1;padding:3px;min-height:30px;text-decoration:underline}.eyebrow{letter-spacing:2.1px;font-size:11px;font-weight:800;color:#b692c7;margin-bottom:13px}.pill{display:inline-flex;align-items:center;border:1px solid #5c376d;background:#24102e;border-radius:24px;padding:6px 12px;font-size:12px;white-space:nowrap}.loading{text-align:center;margin:30vh auto}.topbar{position:sticky;top:0;background:#0a070bed;backdrop-filter:blur(14px);z-index:10;border-bottom:1px solid #ffffff0d}.topbar-inner{max-width:1180px;min-height:86px;margin:auto;display:flex;align-items:center;gap:15px;padding:14px 24px}.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;white-space:nowrap}.brand img{width:43px;height:43px}.brand>span{font:italic bold 29px Georgia,serif;letter-spacing:-1px}.brand>span>span{color:#8a31b4}.header-right{margin-left:auto;display:flex;gap:10px;align-items:center}.wallet-chip{font-size:18px;font-weight:750;margin-right:6px}.landing{max-width:1100px;margin:auto;padding:20px 30px 0}.hero{min-height:450px;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:15px;position:relative;padding:45px 5px 20px}.hero:before{content:'';position:absolute;inset:5% -10% 0;z-index:-1;background:radial-gradient(ellipse,#31104180,transparent 65%)}.hero h1{font:italic bold clamp(50px,7vw,86px)/.95 Georgia,serif;letter-spacing:-3px;margin-bottom:20px}.hero h1 span{display:block;color:#eed8f8}.hero-caption{font:italic 30px Georgia,serif;margin-bottom:15px;color:white}.hero-sub{color:var(--muted);font-size:14px;max-width:280px}.hero-actions{display:flex;gap:12px;margin:28px 0}.hero-actions button{min-width:140px}.hero-cards{height:310px;width:100%;position:relative;filter:drop-shadow(0 20px 35px #000)}.hero-card{position:absolute;left:calc(50% - 65px);top:42px;width:130px;height:194px;background:linear-gradient(135deg,#fff,#d6dfd8);border-radius:11px;color:#1d1421;padding:13px;box-shadow:0 0 0 1px #fff9,0 7px 15px #0008;transform-origin:50% 105%}.hero-card>span{font:bold 29px/1 Georgia,serif;display:flex;flex-direction:column}.hero-card>span:last-child{position:absolute;bottom:14px;right:12px;transform:rotate(180deg)}.hero-card small{font-size:23px}.hero-card b{font-size:70px;position:absolute;top:56px;left:31px}.hero-card.red{color:#860c32}.card-0{transform:rotate(-30deg)}.card-1{transform:rotate(-15deg)}.card-2{transform:rotate(0deg)}.card-3{transform:rotate(15deg)}.card-4{transform:rotate(30deg)}.divider-title{display:flex;align-items:center;gap:20px;letter-spacing:2px;font-size:13px;font-weight:750;text-align:center;white-space:nowrap;margin:30px 0 22px}.divider-title:before,.divider-title:after{content:'';height:1px;background:linear-gradient(90deg,transparent,#754052);flex:1}.divider-title:after{transform:rotate(180deg)}.bonus-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.bonus-card{position:relative;overflow:hidden;background:linear-gradient(140deg,#250d30,#160c1a);border:1px solid #512367;text-align:left;min-height:160px;padding:23px 24px;display:flex;flex-direction:column;gap:8px}.bonus-card:after{content:'';position:absolute;bottom:-25px;right:-20px;width:140%;height:45px;background:var(--wine);transform:rotate(-8deg)}.bonus-card span{font-size:14px}.bonus-card strong{font-size:44px;letter-spacing:-2px}.bonus-card small{color:var(--muted);z-index:1}.intro-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.intro-card{background:#17101b;border:1px solid var(--line);text-align:left;display:flex;align-items:center;gap:24px;padding:24px}.intro-card .suit{color:#e7eee7;font-size:40px}.intro-card:nth-child(even) .suit{color:#bb345b}.intro-card h3{margin:0;font-size:19px}.intro-card div>span{font-size:13px;color:var(--muted)}.intro-card>b{margin-left:auto;font-size:23px;color:#a778bd}.support-strip{display:flex;align-items:center;justify-content:center;gap:10px;margin:42px 0 25px;font-size:14px}footer{border-top:1px solid var(--line);padding:22px 0;text-align:center;color:var(--muted);font-size:12px}footer a{margin-left:25px;color:var(--muted)}.app-main{max-width:1050px;margin:auto;padding:30px 26px 130px}.section-title{margin:30px 0 15px}.section-title .muted{font-size:14px;margin-bottom:10px}.mode-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.mode-tab{background:#31111d;border:1px solid #603044;display:flex;flex-direction:column;gap:5px;padding:16px 10px}.mode-tab span{font-size:14px}.mode-tab b{font-size:18px}.mode-tab.selected{background:linear-gradient(120deg,#6d0a9c,#41075c);border-color:#be87d8;box-shadow:0 0 0 2px #a676bd22}.lobby-meta{display:flex;gap:15px;align-items:center;color:var(--muted);font-size:13px;margin-bottom:23px}.stake-list{display:grid;gap:25px}.stake-panel{border:1px solid #684976;border-radius:18px;overflow:hidden;background:linear-gradient(150deg,#1e0a28,#120c15 70%)}.stake-heading{display:flex;align-items:center;gap:20px;padding:20px 24px;background:#281033;border-bottom:1px solid #452e50}.stake-heading h2{font-size:30px;margin:0}.stake-heading>span{border-left:1px solid #775f82;padding-left:20px;font-weight:600}.stake-heading small{margin-left:auto;color:#c4b4cc}.seat-group{padding:20px 24px 10px}.seat-group:last-child{padding-bottom:24px}.seat-group h3{font-size:15px;margin-bottom:14px}.seat-group h3 span{float:right;color:var(--muted);font-size:12px;font-weight:400}.table-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.table-button{min-height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #8438a8;gap:6px}.table-button strong{font-size:28px;letter-spacing:-1px}.table-button span{font-size:10px;font-weight:500;color:#d5eadd}.table-button.wine{border-color:#97314f}.bottom-nav{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:center;gap:8px;padding:10px 20px max(12px,env(safe-area-inset-bottom));background:#0e0a10eb;border-top:1px solid #392b3f;backdrop-filter:blur(18px);z-index:12}.nav-item{background:transparent;border:1px solid transparent;border-radius:13px;min-width:125px;display:flex;flex-direction:column;gap:4px;padding:8px 15px;font-size:11px}.nav-item>span{font-size:24px;line-height:26px}.nav-item.active{background:#4d0b6c;border-color:#73209a}.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:25px;margin-bottom:25px}.panel p:last-child{margin-bottom:0}.signup-status{margin-bottom:35px}.credentials{border-left:3px solid var(--green);padding-left:20px}.credentials code{font-size:16px;word-break:break-all}.history-list{display:grid;gap:15px}.history-card{background:var(--panel);border:1px solid var(--line);padding:22px;border-radius:15px;display:flex;align-items:center;gap:18px}.history-suit{font-size:35px}.history-card div{flex:1}.history-card h3{font-size:15px;word-break:break-word}.history-card p{font-size:12px;margin:0}.balance-card{background:radial-gradient(ellipse at top right,#49235b,transparent 70%),linear-gradient(135deg,#260e31,#1c1021);border:1px solid #6c437f;border-radius:20px;padding:32px;margin-bottom:20px;display:flex;flex-direction:column;gap:18px}.balance-card>span{color:var(--muted);font-size:13px}.balance-card>strong{font-size:43px;letter-spacing:-2px}.balance-card>div{display:flex;gap:10px}.loss-panel{display:flex;align-items:center;gap:20px;justify-content:space-between}.loss-panel p{font-size:13px;margin-bottom:0}.list{border-top:1px solid var(--line);margin-bottom:30px}.list-row{display:flex;align-items:center;gap:15px;padding:19px 5px;border-bottom:1px solid var(--line);font-size:14px}.list-row>div{flex:1}.list-row small{display:block;color:var(--muted);margin-top:5px;font-size:11px}.empty{text-align:center;padding:55px 20px}.modal-shade{position:fixed;inset:0;z-index:50;background:#000c;backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:20px}.modal{width:100%;max-width:480px;max-height:90dvh;overflow:auto;background:#17101a;border:1px solid #533b5e;border-radius:20px;padding:27px;box-shadow:0 25px 90px #000}.modal>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.modal header h2{margin:0}.modal .muted{font-size:13px}.modal form,.admin-login form{display:grid;gap:17px}label{display:flex;flex-direction:column;gap:8px;font-size:12px;color:#bbcbbf;font-weight:600}input,select{width:100%;border:1px solid #4b3b53;background:#0d080f;color:white;padding:13px 14px;border-radius:9px;min-height:46px;min-width:0}input[type=file]{font-size:11px;padding:12px 6px}input[type=checkbox]{width:18px;min-height:18px;accent-color:#65138b}.check{flex-direction:row;align-items:center}.form-message{font-size:13px;color:#f5a9c0;margin:0}.form-message:empty{display:none}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:end}.form-grid>.form-message{grid-column:1/-1}.form-grid>.muted{grid-column:1/-1}.qr{width:150px;max-height:180px;object-fit:contain;border-radius:10px}.bank-details{padding:15px;background:#110915;border-radius:12px;font-size:13px;margin-bottom:18px}.menu-list{display:grid;gap:12px}.rules p{font-size:13px}.admin-login{width:100%;max-width:440px;margin:8vh auto;padding:25px}.admin-login>.brand{margin-bottom:42px}.admin-login form{margin:25px 0}.admin-shell{display:grid;grid-template-columns:245px 1fr;min-height:100dvh}.admin-sidebar{background:#110c14;border-right:1px solid var(--line);padding:30px 18px;position:sticky;top:0;height:100dvh;overflow:auto}.admin-sidebar>.brand{margin-bottom:30px}.admin-sidebar>.brand>span{font-size:23px}.admin-sidebar nav{display:grid;gap:5px;margin:25px 0}.admin-nav{text-align:left;background:transparent;color:#b6c7bb;font-size:13px;border-radius:8px;padding:11px 13px;font-weight:500}.admin-nav.active{background:#2e1739;color:#fff}.admin-main{padding:38px;min-width:0}.admin-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:30px}.admin-heading h1{font-size:29px;margin:0}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.stat{display:flex;flex-direction:column;gap:18px}.stat span{font-size:12px;color:var(--muted)}.stat strong{font-size:37px}.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:13px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:12px;text-align:left;background:#151018}th,td{padding:16px;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.5}th{background:#211527;color:#b7cabe;font-size:11px;text-transform:uppercase;letter-spacing:1px}td small{display:block;color:var(--muted);margin-top:5px}td button{margin:2px}td:last-child{min-width:150px}.game-viewport{position:fixed;inset:0;background:#0c080e;display:flex;flex-direction:column;width:100dvw;height:100dvh;overflow:hidden}.game-viewport.manual{inset:auto;left:50%;top:50%;width:100dvh;height:100dvw;transform:translate(-50%,-50%) rotate(90deg)}.game-top{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 15px;border-bottom:1px solid #342839}.game-top>div{display:flex;gap:14px;align-items:center}.game-top>span{font-size:12px;color:var(--muted)}.game-top .brand>span{font-size:22px}.game-top .brand img{width:25px;height:25px}.game-top .small{font-size:11px;min-height:32px;padding:5px 10px}.game-content{display:flex;flex-direction:column;min-height:0;flex:1;padding:12px 20px 8px;gap:8px}.rummy-felt{background:radial-gradient(ellipse at center,#3b164d,#1f092a 80%);border:7px solid #471426;box-shadow:0 0 0 2px #82616d, inset 0 0 55px #0009;border-radius:130px;position:relative;flex:1;min-height:170px;padding:14px 35px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}.felt-brand{position:absolute;top:55%;left:50%;transform:translate(-50%,-50%);font:italic 50px Georgia;color:#ffffff08;pointer-events:none}.opponents{display:flex;justify-content:space-evenly;gap:10px;z-index:1}.player-seat{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:70px;font-size:11px;max-width:150px;text-align:center}.player-seat b{font-size:11px;white-space:nowrap;overflow:hidden;max-width:130px;text-overflow:ellipsis}.player-seat small,.player-seat>span:last-child{font-size:9px;color:#cdbbd6}.player-seat.out{opacity:.35}.avatar{width:30px;height:30px;border:1px solid #9775a7;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#22102b;font-size:16px;font-weight:700}.turn .avatar{box-shadow:0 0 0 3px #881cbb,0 0 15px #8026ab}.table-center{display:flex;justify-content:center;z-index:1;min-height:80px;align-items:center;flex:1}.waiting,.result{text-align:center;padding:7px}.waiting h2,.result h2{font-size:21px;margin-bottom:6px}.waiting p,.result p{font-size:12px;margin-bottom:5px}.waiting small{font-size:10px;line-height:1.4;color:#c9dfce}.waiting .eyebrow,.result .eyebrow{font-size:9px;margin-bottom:6px}.deck-area{display:flex;align-items:center;gap:24px;padding:10px}.deck-area>div{display:flex;flex-direction:column;align-items:center;gap:7px}.pile-label{font-size:9px;color:#c7d7cc}.deck-back{width:50px;height:70px;border-radius:6px;border:3px solid #ecefe7;background:repeating-linear-gradient(45deg,#68162e,#68162e 4px,#862443 4px,#862443 6px);padding:0;font-size:30px}.deck-back span{background:#591528;border:1px solid #d8a9b5;border-radius:50%;padding:3px}.discard-pile{padding:0;background:none;border:none;min-height:0}.playing-card{position:relative;width:50px;height:70px;flex:0 0 50px;background:linear-gradient(130deg,#fff,#dce4dc);border-radius:5px;color:#211327;border:1px solid #bdc9be;padding:5px;box-shadow:0 2px 4px #0005;display:block;min-height:0}.playing-card>span{font:bold 17px/1 Georgia;display:flex;flex-direction:column;align-items:flex-start}.playing-card small{font-size:12px}.playing-card>b{font-size:24px;position:absolute;right:6px;bottom:6px}.playing-card.red{color:#931638}.playing-card i{position:absolute;right:3px;top:2px;font-size:8px;background:#550c78;color:white;padding:1px 2px;border-radius:3px;font-style:normal}.playing-card.chosen{transform:translateY(-11px);outline:3px solid #a839dc;z-index:2}.hand-area{flex:0 0 auto;max-width:1080px;width:100%;margin:auto}.hand-heading{display:flex;justify-content:space-between;font-size:11px;padding:0 8px 4px;gap:10px}.hand-heading small{color:var(--muted);font-size:10px;font-weight:400}.hand-heading>span{color:#c1d5c7;font-size:10px}.hand-cards{display:flex;justify-content:center;gap:5px;padding:12px 12px 4px;min-height:85px}.game-actions{display:flex;gap:8px;align-items:center;padding-top:5px}.game-actions .small{font-size:11px;padding:7px 13px;min-height:32px}.action-help{font-size:10px;color:var(--muted);margin-right:auto}.in-game{overflow:hidden}#toast{position:fixed;bottom:110px;left:50%;transform:translateX(-50%) translateY(15px);max-width:90%;background:#2c1a35;border:1px solid #7d5291;padding:13px 20px;border-radius:12px;color:white;font-size:13px;z-index:100;opacity:0;pointer-events:none;transition:.2s}#toast.show{opacity:1;transform:translateX(-50%)}
@media(min-width:800px){.table-grid{grid-template-columns:repeat(5,1fr)}.table-button{min-height:95px}.seat-group{padding-top:24px}.seat-group h3 span{float:none;margin-left:15px}.stake-panel{display:grid;grid-template-columns:140px 1fr}.stake-heading{grid-row:1/3;display:flex;flex-direction:column;justify-content:center;border-right:1px solid var(--line);border-bottom:0;padding:20px 10px;gap:10px}.stake-heading>span{border:0;padding:0;font-size:13px}.stake-heading small{margin:0;font-size:10px}.seat-group:last-child{padding-bottom:24px}}
@media(max-width:700px){.topbar-inner{min-height:72px;padding:13px 14px;gap:6px}.brand>span{font-size:23px}.brand img{width:33px;height:33px}.header-right{gap:6px}.header-right .small{font-size:11px;padding:8px 10px;min-height:35px}.header-right .wallet-chip{font-size:13px}.topbar-inner>.icon-button{padding:5px;min-width:30px;font-size:23px}.landing{padding:10px 20px 0}.hero{grid-template-columns:1fr;gap:0;text-align:center;padding:26px 0 0;min-height:auto}.hero h1{font-size:63px;letter-spacing:-3px;margin-bottom:10px}.hero h1 span{display:inline;margin-left:4px}.hero .eyebrow{font-size:10px}.hero-caption{font-size:26px;margin-bottom:10px}.hero-sub{margin:0 auto;font-size:12px}.hero-actions{justify-content:center;margin:21px 0 0}.hero-actions button{min-width:135px;font-size:13px}.hero-cards{height:250px;margin-top:0}.hero-card{width:110px;height:160px;left:calc(50% - 55px);top:35px}.hero-card>span{font-size:23px}.hero-card small{font-size:19px}.hero-card b{font-size:57px;top:48px;left:28px}.bonus-grid{gap:8px}.bonus-card{padding:15px 10px;min-height:145px;text-align:center;align-items:center;gap:9px;border-radius:12px}.bonus-card span{font-size:11px;min-height:29px;max-width:85px;line-height:1.4}.bonus-card strong{font-size:34px}.bonus-card small{font-size:9px}.divider-title{font-size:10px;letter-spacing:1.4px;gap:10px;margin:20px 0 16px}.intro-grid{gap:10px}.intro-card{padding:16px 10px;gap:11px}.intro-card h3{font-size:14px}.intro-card div>span{font-size:11px}.intro-card .suit{font-size:30px}.intro-card>b{font-size:15px}.support-strip{font-size:11px;gap:5px;flex-wrap:wrap;margin-top:25px}.support-strip button{font-size:11px}.app-main{padding:20px 16px 115px}.mode-tabs{gap:7px}.mode-tab{padding:13px 5px;border-radius:10px;min-height:70px}.mode-tab span{font-size:10px}.mode-tab b{font-size:13px}.section-title{margin-top:25px}.section-title .muted{font-size:12px}.lobby-meta{font-size:10px;gap:10px}.stake-heading{padding:17px 18px;gap:12px}.stake-heading h2{font-size:27px}.stake-heading>span{font-size:13px;padding-left:13px}.stake-heading small{font-size:10px}.seat-group{padding:18px 16px 6px}.seat-group:last-child{padding-bottom:20px}.table-grid{gap:11px}.table-button{min-height:80px;padding:12px 5px}.table-button strong{font-size:27px}.nav-item{min-width:0;flex:1;font-size:10px;padding:7px 10px}.bottom-nav{padding:8px 12px 12px;gap:5px}.history-card{flex-wrap:wrap;padding:16px;gap:12px}.history-card .pill{font-size:10px}.history-suit{font-size:25px}.panel{padding:20px}.loss-panel{flex-wrap:wrap}.balance-card{padding:24px}.balance-card>strong{font-size:38px}.modal-shade{padding:14px}.modal{padding:23px}.form-grid{grid-template-columns:1fr}.admin-shell{grid-template-columns:1fr}.admin-sidebar{position:relative;height:auto;padding:18px;border-right:0;border-bottom:1px solid var(--line)}.admin-sidebar>.brand{margin-bottom:12px}.admin-sidebar>.eyebrow{display:none}.admin-sidebar nav{display:flex;overflow:auto;margin:10px 0;gap:5px}.admin-nav{white-space:nowrap;font-size:11px;padding:8px 12px;min-height:37px}.admin-sidebar>.ghost{position:absolute;top:17px;right:17px;font-size:11px;min-height:35px}.admin-main{padding:24px 16px}.stats-grid{grid-template-columns:repeat(2,1fr);gap:10px}.stat{padding:18px}.stat strong{font-size:30px}.admin-heading h1{font-size:25px}.admin-heading .eyebrow{font-size:9px}.game-top .brand{display:none}.game-top>span{font-size:10px}.game-content{padding:8px 12px}.hand-cards{gap:2px;padding:12px 4px 4px}.hand-cards .playing-card{width:43px;flex-basis:43px;height:62px}.game-actions{gap:5px}.game-actions .small{padding:5px 10px}.action-help{font-size:9px}.rummy-felt{padding:10px 22px;border-width:5px}.opponents{gap:5px}.player-seat b{max-width:85px;font-size:9px}.player-seat{min-width:55px}.player-seat small,.player-seat>span:last-child{font-size:8px}.game-top{padding:4px 9px}}
@media(max-height:500px) and (orientation:landscape){.game-top{min-height:40px}.game-content{padding:5px 15px;gap:3px}.rummy-felt{min-height:135px;padding:7px 30px}.avatar{height:25px;width:25px;font-size:13px}.player-seat{gap:1px}.deck-area{padding:2px;gap:20px}.deck-back,.deck-area .playing-card{height:57px;width:42px}.playing-card{height:59px;width:43px;flex-basis:43px}.playing-card>span{font-size:14px}.playing-card>b{font-size:20px}.hand-cards{min-height:67px;padding-top:9px;gap:5px}.hand-heading{padding-bottom:0}.game-actions{padding-top:2px}.game-actions .small{min-height:28px;padding:4px 10px}.waiting h2{font-size:18px}.waiting small{font-size:9px}.waiting .eyebrow{display:none}.hand-cards .muted{margin:10px}}

/* A rotated portrait container uses its own compact layout; viewport media queries
   still refer to the physical portrait viewport, so these overrides are explicit. */
.game-viewport.manual .game-top{min-height:38px;padding:4px 10px}
.game-viewport.manual .game-content{padding:5px 12px;gap:3px}
.game-viewport.manual .rummy-felt{min-height:125px;padding:7px 24px;border-width:5px}
.game-viewport.manual .avatar{width:25px;height:25px;font-size:13px}
.game-viewport.manual .player-seat{gap:1px}
.game-viewport.manual .deck-area{padding:2px;gap:18px}
.game-viewport.manual .deck-back,.game-viewport.manual .deck-area .playing-card{width:42px;height:57px}
.game-viewport.manual .hand-cards{min-height:67px;padding-top:9px;gap:4px}
.game-viewport.manual .hand-cards .playing-card{width:43px;flex-basis:43px;height:59px}
.game-viewport.manual .game-actions{padding-top:2px}
.game-viewport.manual .game-actions .small{min-height:28px;padding:4px 10px}
.game-viewport.manual .waiting h2{font-size:18px}
.game-viewport.manual .waiting .eyebrow{display:none}
.game-viewport.manual .waiting small{font-size:9px}
@media(orientation:portrait){.game-viewport:not(.manual) .hand-cards{flex-wrap:wrap}.game-viewport:not(.manual) .game-top>span{display:none}.game-viewport:not(.manual) .action-help{display:none}.game-viewport:not(.manual) .opponents{flex-wrap:wrap}.game-viewport:not(.manual) .player-seat{width:27%}.game-viewport:not(.manual) .game-actions{justify-content:center}}

````


## 12. `public/theme.css`

````css
/* Final WAR OF CARDS visual system. Landing gold/blue/purple;
   signed-in controls plain purple/maroon; game table charcoal/maroon. */
:root{--bg:#000;--panel:#17121b;--line:#49324f;--muted:#b6abbc;--green:#64208c;--green-dark:#471363;--wine:#740d32;--gold:#edc75f;background:#000;color:#fff}
body{background:#000}button,.primary{background:#64208c;border-color:#793b96}.wine{background:#740d32;border-color:#933455}.ghost,.icon-button{background:transparent}.ghost{border-color:#68526f}.link-button{background:none;color:#dbc3eb}.eyebrow{color:#c3a2d4}.positive{color:#d4a5ef}.pill{background:#64208c;border-color:#a461b4}.panel{background:#17121b;border-color:#49324f}input,select{background:#0c090e;border-color:#57415f}.bottom-nav{background:#000f;border-color:#3c303f}.nav-item{background:transparent}.nav-item.active{background:#64208c;border-color:#64208c}.balance-card{background:#291334;border-color:#78458f}.list{border-color:#49324f}.bank-details{background:#211126}#toast{background:#381347;border-color:#9b6aad}.admin-sidebar{background:#100d12}.admin-nav{background:none}.admin-nav.active{background:#3a1a4c}.stat{background:#1b1321}table{background:#17121b}th{background:#301638;color:#ead9f1}input[type=checkbox]{accent-color:#64208c}
.topbar{background:#000f;border-color:#49324f}.topbar-inner{max-width:1050px}.landing-wordmark{font:bold 24px Georgia,serif;color:#edc75f;text-decoration:none;white-space:nowrap}.brand>img{width:145px;height:90px;object-fit:contain}.brand-wordmark{display:none!important}.signed-in .topbar-inner{display:grid;grid-template-columns:42px 1fr 125px;gap:6px;padding:8px 20px}.signed-in .brand{justify-self:center}.signed-in .brand img{width:210px;height:95px}.wallet-chip{background:#64208c;border:1px solid #8a4da2;padding:9px 13px;border-radius:12px;white-space:nowrap;font-size:17px;text-align:center}.signed-in .account-actions{grid-column:1/-1;display:flex;justify-content:center;gap:20px}.account-actions button{min-width:150px}
.landing{max-width:850px;padding:5px 25px 0}.landing .hero{display:flex;flex-direction:column;min-height:0;gap:8px;padding:0;text-align:center}.hero:before{display:none}.hero-logo{display:block;width:100%;max-width:680px;height:auto;object-fit:contain}.world-badge{font:bold 24px Georgia,serif;letter-spacing:.5px;color:#fff;border:2px solid #d6a943;border-radius:30px;padding:8px 28px;line-height:1.1}.hero-caption{font:bold 30px Georgia,serif;color:#fff;margin:0}.hero-actions{margin:16px 0 0;gap:18px;width:100%;justify-content:center}.hero-actions button{width:43%;font:bold 24px Georgia,serif;padding:17px 20px;border:2px solid #edc75f;border-radius:16px}.gold-button{background:linear-gradient(#ffed91,#e6a727)!important;color:#130b00;border:1px solid #ffe398}.landing .wine,.topbar:not(.signed-in) .wine{background:linear-gradient(#7812a4,#260638);border-color:#eac163}.topbar:not(.signed-in){border-bottom:1px solid #b28c39}.landing .divider-title{font:bold 20px Georgia,serif;color:#fff;letter-spacing:.2px;margin:24px 0 16px}.landing .divider-title:before,.landing .divider-title:after{background:linear-gradient(90deg,transparent,#e4ba4e)}.landing .bonus-card{background:linear-gradient(135deg,#06338a,#07143a);border:2px solid #dfb750;border-radius:14px;align-items:center;text-align:center;min-height:145px;padding:19px 10px;gap:6px}.landing .bonus-card:nth-child(2){background:linear-gradient(135deg,#651581,#22062c)}.landing .bonus-card:after{display:none}.landing .bonus-card span{font:bold 18px/1.2 Georgia,serif;max-width:145px}.landing .bonus-card strong{font:bold 48px/1 Georgia,serif;color:#f6d975;letter-spacing:-1px}.landing .bonus-card small{color:#fff;font-size:10px}.landing .intro-card{background:linear-gradient(135deg,#06338a,#07143a);border:2px solid #dfb750;border-radius:15px;padding:22px}.landing .intro-card:nth-child(2),.landing .intro-card:nth-child(3){background:linear-gradient(135deg,#651581,#22062c)}.landing .intro-card .suit,.landing .intro-card>b{color:#f3d475}.landing .intro-card h3{font:bold 21px Georgia,serif}.landing .intro-card div>span{color:#fff;font-family:Georgia,serif}.landing .support-strip{border:2px solid #dfb750;border-radius:45px;background:linear-gradient(105deg,#082962,#58126c);max-width:500px;margin:30px auto 20px;padding:15px 20px;font-weight:650}.landing footer{border-color:#795b24;color:#ddd}
.lobby-main{max-width:1050px;padding-top:12px}.mode-tabs{gap:9px}.mode-tab{background:#740d32;border:1px solid #96334f;padding:12px 7px;min-height:64px;gap:0}.mode-tab.selected{background:#64208c;border:2px solid white;box-shadow:none}.mode-tab span{font-size:17px}.mode-tab b{font-size:18px}.lobby-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 25px}.lobby-title h1{font-size:28px;margin-bottom:3px;letter-spacing:-.5px}.lobby-title p{font-size:17px;margin:0}.lobby-title .pill{font-size:19px;font-weight:700;border-radius:15px;padding:9px 15px}.stake-list{gap:13px}.stake-panel{display:grid;grid-template-columns:155px 1fr;border:7px solid #fff;border-radius:19px;background:#fff;padding:0;gap:0}.stake-heading{grid-column:1;grid-row:1/3;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:7px;background:#740d32;border:0;border-radius:12px;padding:8px 5px;color:#fff}.stake-heading h2{font-size:35px;letter-spacing:-1px;line-height:1.1}.stake-heading>span{border:0;padding:0;font-size:18px;white-space:nowrap}.seat-group,.seat-group:last-child{grid-column:2;display:grid;grid-template-columns:125px 1fr;gap:10px;padding:4px 8px 4px 15px;align-items:center;background:#fff}.seat-group h3{font-size:17px;color:#111;margin:0;border-left:2px solid #ccc;padding-left:14px;white-space:nowrap}.seat-group h3 span{display:none}.table-grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.table-button{min-height:42px;padding:5px 3px;background:#64208c;border:0;border-radius:10px}.table-button.wine{background:#740d32;border:0}.table-button strong{font-size:23px;font-weight:750;letter-spacing:0}.table-button:disabled{opacity:.28}.table-button:focus-visible{outline-color:#111}.seat-group:first-of-type{border:0}
.game-viewport{--cw:clamp(30px,calc((100dvw - 130px)/14),64px);background:#000}.game-viewport.manual{--cw:clamp(30px,calc((100dvh - 130px)/14),64px)}.game-top{min-height:42px;border-color:#4e4e4e;gap:8px;padding:4px 10px}.game-top>div{gap:10px}.game-top .game-wordmark{font:bold 19px Georgia,serif;color:#d9bb72;white-space:nowrap}.game-top>span{color:#fff;font-size:14px;font-weight:700}.game-top .wallet-chip{font-size:13px;padding:5px 10px;border-radius:8px}.game-top .small{min-height:30px;padding:4px 8px}.game-content,.game-viewport.manual .game-content{display:flex;flex-direction:column;position:relative;padding:7px 10px 6px;gap:7px;min-height:0;flex:1}.rummy-felt,.game-viewport.manual .rummy-felt{position:relative;flex:1;min-height:175px;background:radial-gradient(ellipse,#232127,#111014);border:7px solid #740d32;box-shadow:inset 0 0 0 2px #64208c;border-radius:50%;padding:0;overflow:hidden}.felt-brand{top:53%;font:bold 33px Georgia,serif;color:#ffffff0b;white-space:nowrap}.opponents{display:block;position:absolute;inset:0;z-index:2;pointer-events:none}.player-seat,.game-viewport.manual .player-seat{position:absolute;display:flex;flex-direction:row;gap:7px;align-items:center;width:19%;max-width:215px;min-width:90px;background:#100c12eb;border:2px solid #9865a5;border-radius:16px;padding:8px;text-align:left;font-size:12px;transform:translateX(-50%)}.player-seat>div{min-width:0;display:flex;flex-direction:column;gap:3px}.player-seat b{font-size:12px;max-width:150px}.player-seat small{font-size:10px;line-height:1.2;color:#d7c5dd}.player-seat:nth-child(1){left:23%;top:6%}.player-seat:nth-child(2){left:50%;top:3%}.player-seat:nth-child(3){left:77%;top:6%}.player-seat:nth-child(4){left:12%;top:36%}.player-seat:nth-child(5){left:88%;top:36%}.two-player .player-seat:first-child{left:50%;top:5%}.mini-cards{color:#aa4266;font-size:20px;white-space:nowrap;line-height:1}.player-seat.turn{border-color:#a83bf0;box-shadow:0 0 0 2px #64208c}.avatar,.game-viewport.manual .avatar{width:31px;height:31px;flex-shrink:0;background:#64208c;border:1px solid #c28ad9}.turn .avatar{box-shadow:none}.table-center{position:absolute;left:25%;right:25%;top:23%;bottom:32%;display:flex;justify-content:center;align-items:center;min-height:0}.deck-area,.game-viewport.manual .deck-area{display:flex;gap:25px;padding:0;justify-content:center}.deck-area>div{display:flex;flex-direction:column;align-items:center;gap:6px}.playing-card{width:var(--cw);height:calc(var(--cw)*1.48);flex-basis:var(--cw);background:#fafafa;color:#111;border:1px solid #ddd}.playing-card.red{color:#b21636}.playing-card>span{font-size:clamp(14px,2vw,25px)}.playing-card small{font-size:12px}.playing-card>b{font-size:clamp(22px,3vw,35px);right:5px;bottom:6px}.playing-card i{background:#64208c}.playing-card.chosen{outline:3px solid #9b28e7;transform:translateY(-7px)}.deck-back,.game-viewport.manual .deck-back{width:var(--cw);height:calc(var(--cw)*1.48);background:repeating-linear-gradient(45deg,#740d32,#740d32 4px,#951b4c 4px,#951b4c 6px);color:#fff;border:3px solid #eee;border-radius:6px;font-size:28px}.game-viewport.manual .deck-area .playing-card{width:var(--cw);height:calc(var(--cw)*1.48)}.pile-label{font-size:11px;color:#fff;white-space:nowrap}.hand-area{position:absolute;bottom:4%;left:3%;right:3%;width:94%;max-width:none;margin:0;z-index:3}.hand-heading{display:flex;justify-content:center;align-items:center;gap:15px;padding:0 0 4px;min-height:28px}.hand-heading>b{border:1px solid #87559b;background:#140b19;border-radius:20px;padding:4px 13px;font-size:12px}.hand-heading small{font-size:10px;color:#c7b2d1}.hand-heading .turn-timer{background:#64208c;border:2px solid #ac59cf;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:white;font-size:12px}.hand-cards,.game-viewport.manual .hand-cards{min-height:0;display:flex;justify-content:center;gap:2px;padding:8px 0 0;flex-wrap:nowrap}.hand-cards .playing-card,.game-viewport.manual .hand-cards .playing-card{width:var(--cw);height:calc(var(--cw)*1.48);flex-basis:var(--cw)}.action-help{font-size:11px;color:#fff;text-align:center;margin:4px 0 0}.game-actions,.game-viewport.manual .game-actions{display:flex;justify-content:center;gap:14px;padding:0}.game-actions .small,.game-viewport.manual .game-actions .small{width:19%;max-width:225px;border:1px solid #cdb5d5;font-size:16px;min-height:35px;padding:6px 12px;border-radius:12px}.waiting,.result{font-size:12px}.waiting h2,.result h2{font-size:20px}.waiting p,.result p{font-size:12px;margin-bottom:4px}
@media(max-width:700px){
  .topbar-inner{padding:8px 13px;gap:5px;min-height:63px}.landing-wordmark{font-size:17px}.header-right .small{padding:7px 12px;font-size:12px}.landing{padding:4px 13px 0}.landing .hero{padding:0;gap:7px}.hero-logo{width:100%;max-width:430px}.world-badge{font-size:17px;padding:6px 13px}.hero-caption{font-size:22px}.hero-actions{gap:12px;margin-top:10px}.hero-actions button{font-size:20px;padding:12px 10px}.landing .divider-title{font-size:15px;margin:18px 0 12px}.landing .bonus-grid{gap:8px}.landing .bonus-card{min-height:123px;padding:12px 5px}.landing .bonus-card span{font-size:13px;max-width:100px;min-height:32px}.landing .bonus-card strong{font-size:38px}.landing .bonus-card small{font-size:8px}.landing .intro-card{padding:15px 9px;gap:10px}.landing .intro-card h3{font-size:15px}.landing .intro-card .suit{font-size:31px}.landing .support-strip{font-size:12px;margin-top:22px}.signed-in .topbar-inner{grid-template-columns:32px 1fr 91px;padding:5px 12px;gap:3px}.signed-in .brand img{height:76px;width:160px}.wallet-chip{font-size:14px;padding:8px 9px}.account-actions button{min-width:110px}.signed-in .account-actions{gap:16px;padding-bottom:5px}.mode-tabs{gap:5px}.mode-tab{min-height:54px;padding:8px 3px;border-radius:9px}.mode-tab span{font-size:10px}.mode-tab b{font-size:13px}.lobby-main{padding:8px 7px 105px}.lobby-title{margin:13px 5px 18px;gap:8px}.lobby-title h1{font-size:21px}.lobby-title p{font-size:13px}.lobby-title .pill{font-size:13px;padding:6px 9px;border-radius:10px}.stake-list{gap:10px}.stake-panel{grid-template-columns:76px 1fr;border-width:5px;border-radius:12px}.stake-heading{gap:6px;border-radius:7px}.stake-heading h2{font-size:23px}.stake-heading>span{font-size:11px}.seat-group,.seat-group:last-child{grid-template-columns:60px 1fr;padding:3px 3px 3px 6px;gap:5px}.seat-group h3{font-size:10px;padding-left:5px;border-width:1px}.table-grid{gap:4px}.table-button{min-height:31px;border-radius:5px;padding:3px 1px}.table-button strong{font-size:13px}.game-top .game-wordmark{font-size:12px}.game-top>span{font-size:9px}.game-top>div{gap:4px}.game-top .wallet-chip{font-size:10px;padding:4px 7px}.player-seat b{font-size:10px}.player-seat small{font-size:8px}.mini-cards{font-size:14px}.player-seat{border-radius:10px;padding:5px;gap:4px}.hand-heading>b{font-size:10px;padding:3px 9px}.hand-heading small{font-size:8px}.action-help{font-size:9px}.deck-area{gap:17px}.pile-label{font-size:9px}.game-actions .small{font-size:12px}.game-top>span{display:inline!important}
}
@media(max-height:500px) and (orientation:landscape){.rummy-felt{min-height:155px;border-width:5px}.game-top{min-height:35px}.game-top .game-wordmark{font-size:13px}.game-top>span{font-size:10px}.game-content{padding:5px 8px 4px;gap:4px}.player-seat{padding:4px;gap:4px;border-radius:10px}.player-seat .avatar{width:23px;height:23px;font-size:12px}.player-seat b{font-size:9px}.player-seat small{font-size:8px}.mini-cards{font-size:12px}.player-seat:nth-child(4),.player-seat:nth-child(5){top:37%}.hand-area{bottom:3%}.hand-heading{min-height:22px}.hand-heading>b{font-size:10px}.hand-heading .turn-timer{width:26px;height:26px;font-size:10px}.hand-cards{padding-top:5px}.playing-card>span{font-size:14px}.playing-card>b{font-size:22px}.deck-area{gap:18px}.pile-label{font-size:8px}.game-actions .small{min-height:28px;font-size:12px;padding:3px 12px}.action-help{font-size:9px;margin-top:2px}}
.game-viewport.manual .rummy-felt{min-height:150px}.game-viewport.manual .game-top{min-height:35px}.game-viewport.manual .game-top .game-wordmark{font-size:12px}.game-viewport.manual .player-seat{padding:4px;gap:4px;border-radius:10px}.game-viewport.manual .player-seat .avatar{width:23px;height:23px;font-size:12px}.game-viewport.manual .player-seat b{font-size:9px}.game-viewport.manual .player-seat small{font-size:8px}.game-viewport.manual .mini-cards{font-size:12px}.game-viewport.manual .hand-heading>b{font-size:10px}.game-viewport.manual .hand-heading .turn-timer{height:26px;width:26px;font-size:10px}.game-viewport.manual .hand-cards{padding-top:5px}.game-viewport.manual .hand-area{bottom:3%}.game-viewport.manual .game-actions .small{font-size:12px;min-height:28px}.game-viewport.manual .action-help{font-size:9px}.game-viewport.manual .playing-card>span{font-size:14px}.game-viewport.manual .playing-card>b{font-size:22px}.game-viewport.manual .pile-label{font-size:8px}
@media(orientation:portrait){.game-viewport:not(.manual) .hand-cards{flex-wrap:wrap}.game-viewport:not(.manual) .action-help{display:block}.game-viewport:not(.manual) .player-seat{width:26%;min-width:70px;flex-direction:column;text-align:center}.game-viewport:not(.manual) .player-seat:nth-child(1){left:18%}.game-viewport:not(.manual) .player-seat:nth-child(3){left:82%}.game-viewport:not(.manual) .player-seat:nth-child(4){left:15%}.game-viewport:not(.manual) .player-seat:nth-child(5){left:85%}.game-viewport:not(.manual) .table-center{left:25%;right:25%;top:25%;bottom:42%}.game-viewport:not(.manual) .hand-area{bottom:8%}.game-viewport:not(.manual) .game-top .wallet-chip{display:none}.game-viewport:not(.manual) .game-top>span{font-size:8px}.game-viewport:not(.manual) .deck-area{gap:10px}}

````


## 13. `public/tournaments.css`

````css
.bottom-nav .nav-item{min-width:0;width:140px}.bottom-nav .nav-item.tournament-glow{color:#ddffb1;border-color:#b5ff54;box-shadow:0 0 7px #91ff5755,inset 0 0 5px #91ff5722;animation:tournament-light 2.4s ease-in-out infinite}.tournament-glow>span{filter:drop-shadow(0 0 4px #a5ff5c)}@keyframes tournament-light{0%,100%{box-shadow:0 0 5px #b5ff5444}50%{box-shadow:0 0 17px #b5ff54aa,inset 0 0 7px #b5ff5444}}@media(prefers-reduced-motion:reduce){.bottom-nav .tournament-glow{animation:none}}
.tournament-tabs{display:flex;align-items:center;gap:12px;margin:18px 0}.tournament-main>.muted,.tournament-detail .muted{font-size:12px}.tournament-card{margin-top:20px}.tournament-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.tournament-card-top h2{margin:0 0 7px}.tournament-card-top p{font-size:12px;color:#c7b6d1}.tournament-numbers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}.tournament-numbers>div{display:flex;flex-direction:column;gap:8px;background:#21102d;border:1px solid #69427d;border-radius:12px;padding:15px}.tournament-numbers small{color:#c7b7d0}.tournament-numbers b{font-size:22px;word-break:break-word}.tournament-card>button{margin-right:12px}.template-form{border-top:1px solid #765483;margin-top:25px;padding-top:25px}.template-form .wide{grid-column:1/-1}.tournament-detail table{font-size:12px}.tournament-detail td:last-child{min-width:70px}.tournament-detail .panel>button{margin:8px}.tournament-detail h2{margin-top:22px}@media(max-width:700px){.bottom-nav .nav-item{width:auto;flex:1;padding:6px 3px;font-size:9px}.bottom-nav{gap:4px;padding-left:6px;padding-right:6px}.tournament-numbers{gap:7px}.tournament-numbers>div{padding:12px 8px}.tournament-numbers b{font-size:17px}.tournament-numbers small{font-size:10px}.tournament-card{padding:18px 14px}.tournament-card-top h2{font-size:19px}.tournament-detail{padding-left:10px;padding-right:10px}.tournament-tabs{gap:8px}.tournament-tabs button{font-size:12px;padding:10px 12px}}

````


## 14. `public/local-fonts.css`

````css
/* System fonts keep this project completely self-contained. */

````


## 15. `public/assets/logo.svg`

````xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="18" fill="#081710"/><path fill="#fff" d="M23 10C19 20 8 24 8 32a10 10 0 0 0 16 8l-3 11h10l-3-11a10 10 0 0 0 15-8C43 24 31 20 26 10z"/><path fill="#a21341" d="M54 48C39 34 41 20 50 20a9 9 0 0 1 7 4 9 9 0 0 1 7-4c10 0 12 14-10 28z"/><path stroke="#079a58" stroke-width="5" fill="none" d="M12 65q28 12 57-3"/></svg>

````


## 16. `Dockerfile`

````text
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.js game.js tournaments.js setup.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATA_DIR=/app/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

````


## 17. `test/game.test.js`

````javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, STAKES, MODES, BOT_NAMES, shuffledDeck, meldType, analyze, newGame, fillComputers, startRound, drawCard, discardCard, declareHand, viewGame, finishRound } from '../game.js';
let seq=0;const c=(suit,rank)=>({suit,rank,id:`test-${seq++}`});
test('80 tables in each mode; labels restart at T1 for each capacity and stake',()=>{
  assert.equal(TABLES.length,320);
  for(const mode of MODES){assert.equal(TABLES.filter(t=>t.mode===mode.id).length,80);for(const stake of STAKES)for(const cap of [2,6])assert.deepEqual(TABLES.filter(t=>t.mode===mode.id&&t.stake===stake&&t.capacity===cap).map(t=>t.label),['T1','T2','T3','T4','T5']);}
});
test('2000 distinct synthetic names and complete 108-card deck',()=>{assert.equal(BOT_NAMES.length,2000);assert.equal(new Set(BOT_NAMES).size,2000);const deck=shuffledDeck();assert.equal(deck.length,108);assert.equal(new Set(deck.map(c=>c.id)).size,108);});
test('melds reject suit duplicates and wrapping; accept ace high and natural wild',()=>{
  assert.equal(meldType([c('H',12),c('H',13),c('H',1)],5),'pure');
  assert.equal(meldType([c('H',13),c('H',1),c('H',2)],5),null);
  assert.equal(meldType([c('H',4),c('H',5),c('H',6)],5),'pure');
  assert.equal(meldType([c('H',9),c('H',9),c('S',9)],5),null);
  assert.equal(meldType([c('H',9),c('D',9),c('J',0)],5),'set');
  assert.equal(meldType([c('H',3),c('H',5),c('J',0)],9),'sequence');
});
test('declaration requires full 13-card cover, two sequences, one pure',()=>{
  const hand=[c('H',1),c('H',2),c('H',3),c('S',7),c('S',8),c('J',0),c('H',9),c('S',9),c('D',9),c('H',12),c('S',12),c('D',12),c('C',12)];
  const result=analyze(hand,5);assert.equal(result.valid,true);assert.equal(result.score,0);assert.equal(new Set(result.groups.flatMap(g=>g.cards)).size,13);
  assert.equal(analyze(hand.slice(0,12),5).valid,false);
  assert.equal(analyze([c('J',0),c('J',0),c('H',5),c('S',5),c('D',5),c('C',5),c('H',9),c('S',9),c('D',9),c('H',12),c('S',12),c('D',12),c('C',12)],5).valid,false);
});
test('admission timers, bot labels, private hands and turn actions',()=>{
  for(const capacity of [2,6]){const t=TABLES.find(t=>t.capacity===capacity),g=newGame(t,{id:'u',name:'Real Player'},1000);assert.equal(g.deadline,1000+(capacity===2?15000:30000));assert.equal(g.players.length,1);fillComputers(g);assert.equal(g.players.length,capacity);assert.equal(g.players.filter(p=>p.bot).length,capacity-1);startRound(g,2000);assert.equal(g.players[0].hand.length,13);const view=viewGame(g,'u');assert.equal(view.deck,undefined);assert.equal(view.players[1].hand,undefined);assert.equal(view.players[0].hand.length,13);const p=g.players[0];assert.throws(()=>discardCard(g,p,p.hand[0].id),/Draw/);drawCard(g,p,'deck');assert.equal(p.hand.length,14);assert.throws(()=>drawCard(g,p,'deck'),/Discard/);discardCard(g,p,p.hand[0].id);assert.equal(p.hand.length,13);}
});
test('two deals settle only after second deal, ties refund',()=>{const t=TABLES.find(t=>t.mode==='deals'&&t.capacity===2),g=newGame(t,{id:'u',name:'User'});fillComputers(g);startRound(g);g.players[0].score=0;g.players[1].score=0;g.players[1].dropped=true;g.players[1].dropScore=40;finishRound(g,'u');assert.equal(g.status,'roundOver');startRound(g);g.players[1].dropped=true;g.players[1].dropScore=40;finishRound(g,'u');assert.equal(g.status,'finished');assert.equal(g.winnerId,'u');});
test('wrong Show immediately adds 80 but preserves hand, turn, timer and active seat',()=>{
  const g=newGame(TABLES.find(t=>t.capacity===6),{id:'u',name:'User'});fillComputers(g);startRound(g);const p=g.players[0];
  p.hand=[c('H',1),c('H',3),c('H',7),c('H',9),c('H',11),c('H',13),c('D',2),c('D',4),c('D',6),c('D',8),c('D',10),c('D',12),c('S',1),c('C',3)];
  g.wild=5;p.drawn=true;p.score=10;const hand=JSON.stringify(p.hand),deadline=g.turnDeadline;
  assert.deepEqual(declareHand(g,p,p.hand[0].id),{valid:false,penalty:80});
  assert.equal(p.score,90);assert.equal(p.penaltyThisRound,80);assert.equal(p.dropped,false);assert.equal(p.eliminated,false);assert.equal(p.drawn,true);
  assert.equal(JSON.stringify(p.hand),hand);assert.equal(g.turn,0);assert.equal(g.turnDeadline,deadline);assert.equal(g.status,'playing');
  // The player still discards normally in the SAME turn; no second penalty.
  discardCard(g,p,p.hand[0].id);assert.equal(p.hand.length,13);assert.equal(p.score,90);
});
test('ordinary non-winning discard has no 80-point penalty',()=>{
  const g=newGame(TABLES[0],{id:'u',name:'User'});fillComputers(g);startRound(g);const p=g.players[0];drawCard(g,p,'deck');discardCard(g,p,p.hand[0].id);assert.equal(p.score,0);assert.equal(p.penaltyThisRound,0);
});
test('malformed or out-of-turn Show does not trigger score penalty',()=>{
  const g=newGame(TABLES[0],{id:'u',name:'User'});fillComputers(g);startRound(g);const p=g.players[0];assert.throws(()=>declareHand(g,p,p.hand[0].id),/Draw/);p.drawn=true;assert.throws(()=>declareHand(g,p,'not-a-card'),/Select/);g.turn=1;assert.throws(()=>declareHand(g,p,p.hand[0].id),/turn/);assert.equal(p.score,0);
});
test('round scoring does not add the declaration penalty a second time',()=>{
  const g=newGame(TABLES.find(t=>t.mode==='deals'&&t.capacity===2),{id:'u',name:'User'});fillComputers(g);startRound(g);const p=g.players[0];p.score=80;p.penaltyThisRound=80;
  finishRound(g,p.id);assert.equal(p.roundScore,0);assert.equal(p.score,80);startRound(g);assert.equal(p.penaltyThisRound,0);assert.equal(p.score,80);
});

````


## 18. `test/server.test.js`

````javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { newGame, tableById, fillComputers, startRound, shuffledDeck } from '../game.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('end-to-end identity isolation, wallet idempotency, timer admission and persistence', {timeout:60000}, async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'play-rummy-test-')),port=42000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`,password='Test!'+randomBytes(12).toString('hex');let child;
  async function start(){child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:String(port),ADMIN_ID:'testowner',ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),7000);child.stdout.on('data',d=>{if(d.toString().includes('ready on port')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Startup exit '+code));});});}
  async function stop(){if(child&&!child.killed){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});await start();
  const client=()=>{let cookies={};return async(route,data,expected=200)=>{const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; '),...(data===undefined?{}:{'Content-Type':'application/json','X-Play-Rummy':'1'})},body:data===undefined?undefined:JSON.stringify(data)});for(const cookie of r.headers.getSetCookie()){const [kv]=cookie.split(';'),[k,v]=kv.split('=');cookies[k]=v;}const body=await r.json();assert.equal(r.status,expected,JSON.stringify(body));return body;};};
  const admin=client(),alice=client(),other=client();
  await other('/api/admin/state',undefined,401);
  await admin('/api/login',{username:'testowner',password,admin:true});
  await alice('/api/signup',{name:'Alice Test',mobile:'9876543210',username:'alicetest'});
  const request=(await alice('/api/signup-status')).request;assert.equal(request.status,'pending');
  assert.equal((await other('/api/signup-status')).request,null);
  await admin('/api/admin/signup',{id:request.id});
  await other('/api/signup-delivery',{},404);
  const delivered=await alice('/api/signup-delivery',{});assert.equal(delivered.username,'alicetest');
  await alice('/api/signup-delivery',{},404);
  await alice('/api/login',{username:'alicetest',password:delivered.password});
  await alice('/api/tables',undefined,403);
  const user=(await alice('/api/password',{current:delivered.password,password:'Customer!LongPassword',confirm:'Customer!LongPassword'})).user;
  await alice('/api/admin/state',undefined,403);
  assert.equal((await alice('/api/tables')).tables.length,320);
  await admin('/api/admin/customer',{id:user.id,action:'balance',amount:1000,direction:'add',note:'Test credit'});
  const proof='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDV8AAAAASUVORK5CYII=';
  const dep=await alice('/api/request',{kind:'deposit',amount:1000,utr:'TESTUTR12345',promo:'PLAY10',proof});
  await admin('/api/admin/decide',{id:dep.id,decision:'approve'});
  assert.equal((await alice('/api/wallet')).user.balance,220000);
  await admin('/api/admin/decide',{id:dep.id,decision:'approve'},400);
  assert.equal((await alice('/api/wallet')).user.balance,220000);
  const withdraw={kind:'withdrawal',amount:300,holderName:'Alice Test',bankName:'Test Bank',accountNumber:'123456789012',ifsc:'TEST0123456',password:'Customer!LongPassword'};
  const wr=await alice('/api/request',withdraw);assert.equal((await alice('/api/wallet')).user.balance,190000);
  await admin('/api/admin/decide',{id:wr.id,decision:'reject'});assert.equal((await alice('/api/wallet')).user.balance,220000);
  await admin('/api/admin/decide',{id:wr.id,decision:'reject'},400);
  await alice('/api/request',{...withdraw,amount:100000},400);
  await admin('/api/admin/table',{tableId:'point101-10-2-2',disabled:true});
  await alice('/api/join',{tableId:'point101-10-2-2'},400);
  const joined=(await alice('/api/join',{tableId:'point101-10-2-1'})).game;
  assert.equal(joined.players.length,1);assert.equal(joined.status,'waiting');
  assert.equal((await alice('/api/wallet')).user.balance,220000);
  await other('/api/game?id='+joined.id,undefined,401);
  await sleep(10800);
  const filled=(await alice('/api/game?id='+joined.id)).game;assert.equal(filled.players.length,2);assert.equal(filled.players.filter(p=>p.bot).length,1);assert.equal(filled.status,'waiting');
  await sleep(5000);
  const playing=(await alice('/api/game?id='+joined.id)).game;assert.equal(playing.status,'playing');assert.equal(playing.players[0].hand.length,13);assert.equal(playing.players[1].hand,undefined);assert.equal((await alice('/api/wallet')).user.balance,219000);
  await alice('/api/game-action',{gameId:joined.id,action:'draw',source:'deck'});await alice('/api/game-action',{gameId:joined.id,action:'draw',source:'deck'},400);
  await admin('/api/admin/cancel-game',{gameId:joined.id});assert.equal((await alice('/api/wallet')).user.balance,220000);
  await admin('/api/admin/customer',{id:user.id,action:'block',blocked:true});await alice('/api/wallet',undefined,401);
  await admin('/api/admin/customer',{id:user.id,action:'block',blocked:false});await alice('/api/login',{username:'alicetest',password:'Customer!LongPassword'});
  const noCsrf=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(noCsrf.status,403);
  const cross=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Play-Rummy':'1',Origin:'https://other.invalid'},body:'{}'});assert.equal(cross.status,403);
  await stop();await start();assert.equal((await alice('/api/wallet')).user.balance,220000);assert.equal((await alice('/api/my-games')).games[0].cancelled,true);
  // Inject a deterministic final-deal fixture only while the test server is stopped.
  // Then use the normal declare endpoint; no production settlement override exists.
  await stop();
  const fixture=newGame(tableById('deals-100-2-1'),{id:user.id,name:'Alice Test'});fillComputers(fixture);startRound(fixture);
  fixture.round=2;fixture.turn=0;fixture.turnDeadline=Date.now()+60000;fixture.nextBotAt=Date.now()+60000;
  const specs=[['H',1],['H',2],['H',3],['S',7],['S',8],['S',9],['H',10],['S',10],['D',10],['H',11],['S',11],['D',11],['C',11]];
  const deck=shuffledDeck(),take=(s,r)=>deck.splice(deck.findIndex(c=>c.suit===s&&c.rank===r),1)[0];
  fixture.players[0].hand=specs.map(([s,r])=>take(s,r));const extra=take('D',2);fixture.players[0].hand.push(extra);fixture.players[0].drawn=true;
  fixture.indicator=take('C',5);fixture.wild=5;fixture.players[1].hand=deck.splice(0,13);fixture.players[1].score=99;fixture.discard=[deck.pop()];fixture.deck=deck;
  const fixtureDb=new DatabaseSync(path.join(dir,'play-rummy.sqlite'));
  fixtureDb.prepare('UPDATE users SET balance=balance-10000 WHERE id=?').run(user.id);
  fixtureDb.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run('fixture-stake',user.id,-10000,'game_stake','Deterministic test entry',fixture.id+':stake:'+user.id,Date.now());
  fixtureDb.prepare('INSERT INTO games VALUES(?,?,?,?,?)').run(fixture.id,fixture.tableId,fixture.status,JSON.stringify(fixture),fixture.created);fixtureDb.close();
  await start();
  const invalidId=fixture.players[0].hand[0].id;
  const wrongRequest={gameId:fixture.id,action:'declare',cardId:invalidId,actionId:'wrong-show-0001'};
  const wrong=await alice('/api/game-action',wrongRequest);assert.equal(wrong.penalty,80);
  const penalized=wrong.game.players.find(p=>p.id===user.id);assert.equal(penalized.score,80);assert.equal(penalized.dropped,false);assert.equal(penalized.eliminated,false);assert.equal(penalized.hand.length,14);assert.equal(penalized.drawn,true);assert.equal(wrong.game.turn,0);assert.equal(wrong.game.status,'playing');assert.equal(wrong.game.turnDeadline,fixture.turnDeadline);
  const repeated=await alice('/api/game-action',wrongRequest);assert.equal(repeated.replayed,true);assert.equal(repeated.game.players.find(p=>p.id===user.id).score,80);
  await stop();await start();
  const persisted=await alice('/api/game-action',wrongRequest);assert.equal(persisted.replayed,true);assert.equal(persisted.game.players.find(p=>p.id===user.id).score,80);
  const result=await alice('/api/game-action',{gameId:fixture.id,action:'declare',cardId:extra.id,actionId:'winning-show-0002'});assert.equal(result.game.status,'finished');assert.equal(result.game.winnerId,user.id);assert.equal(result.game.players.find(p=>p.id===user.id).score,80);
  const paid=await alice('/api/wallet');assert.equal(paid.user.balance,228000);assert.equal(paid.ledger.filter(l=>l.ref===fixture.id+':win:'+user.id).length,1);assert.equal(paid.ledger.find(l=>l.ref===fixture.id+':win:'+user.id).amount,18000);
  await stop();await start();assert.equal((await alice('/api/wallet')).user.balance,228000);
  const tomorrow=await alice('/api/tournaments?date=tomorrow');assert.equal(tomorrow.events.length,18);
  await alice('/api/admin/tournaments',undefined,403);
  const tour=tomorrow.events.find(e=>e.templateId==='starter100');
  await alice('/api/tournament-book',{id:tour.id},400);
  await admin('/api/admin/tournament-action',{action:'fund-adjust',amount:1000000,note:'Tournament integration test reserve'});
  await admin('/api/admin/tournament-action',{action:'open',id:tour.id});
  await alice('/api/tournament-book',{id:tour.id});assert.equal((await alice('/api/wallet')).user.balance,218000);
  assert.equal((await alice('/api/tournament-book',{id:tour.id})).alreadyBooked,true);
  assert.equal((await alice('/api/tournament?id='+encodeURIComponent(tour.id))).event.mine.score,0);
  await alice('/api/tournament-cancel-booking',{id:tour.id});assert.equal((await alice('/api/wallet')).user.balance,228000);
  await alice('/api/tournament-cancel-booking',{id:tour.id},400);
  await admin('/api/admin/tournament-action',{action:'cancel',id:tour.id});assert.equal((await admin('/api/admin/tournaments')).fund,1000000);
});

````


## 19. `test/tournaments.test.js`

````javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createTournamentService,DEFAULT_TOURNAMENTS,localDay,slotStart,rankEntries,validateTemplate} from '../tournaments.js';
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE games(id TEXT PRIMARY KEY,table_id TEXT,status TEXT,state TEXT,created INTEGER);
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,balance INTEGER,loss_progress INTEGER DEFAULT 0);
    CREATE TABLE ledger(id TEXT PRIMARY KEY,user_id TEXT,amount INTEGER,kind TEXT,note TEXT,ref TEXT UNIQUE,created INTEGER);`);
  const user={id:'user-1',name:'Player One',role:'customer'};db.prepare('INSERT INTO users(id,name,balance) VALUES(?,?,?)').run(user.id,user.name,200000);
  let time=Date.parse('2026-11-08T00:00:00Z');const games=new Map();
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
  function credit(id,a,kind,note,ref){if(db.prepare('SELECT 1 FROM ledger WHERE ref=?').get(ref))return false;const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!u||u.balance+a<0)throw Error('LOW BALANCE');db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(a,id);db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,a,kind,note,ref,time);return true;}
  const saveGame=g=>db.prepare('INSERT INTO games VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state').run(g.id,g.tableId,g.status,JSON.stringify(g),g.created);
  const args={db,credit,tx,audit:()=>{},games,saveGame,clock:()=>time},service=createTournamentService(args);
  const event=profile=>service.list(user.id).events.find(e=>e.id.endsWith('6-'+profile));
  return{db,user,games,args,service,event,setTime:t=>{time=t;},balance:()=>db.prepare('SELECT balance FROM users WHERE id=?').get(user.id).balance,close:()=>db.close()};
}
test('IST schedule has six start times and three simultaneous profiles, tomorrow bookable in advance',()=>{
  const f=fixture();try{const today=f.service.list(f.user.id),tomorrow=f.service.list(f.user.id,'tomorrow');assert.equal(today.events.length,18);assert.equal(tomorrow.events.length,18);assert.equal(today.date,'2026-11-08');assert.equal(tomorrow.date,'2026-11-09');for(const h of [6,9,12,15,18,21])assert.equal(today.events.filter(e=>e.start===slotStart(localDay(Date.parse('2026-11-08T00:00Z')),h)).length,3);assert.equal(today.events[0].start-today.events[0].closes,600000);assert.ok(tomorrow.events.every(e=>e.opens<=Date.parse('2026-11-08T00:00Z')));assert.deepEqual(DEFAULT_TOURNAMENTS.map(c=>c.prizes.reduce((a,b)=>a+b,0)),[96000,920000,9200]);}finally{f.close();}
});
test('booking debit, duplicate booking, cancellation refund, rebooking and cutoff are atomic',()=>{
  const f=fixture();try{const e=f.event('classic100');assert.throws(()=>f.service.book(e.id,f.user),/funded/);assert.throws(()=>f.service.adminAction({action:'open',id:e.id},'owner'),/reserve/);
    f.service.adminAction({action:'fund-adjust',amount:10000000,note:'Test funded reserve'},'owner');f.service.adminAction({action:'open',id:e.id},'owner');
    const a=f.service.book(e.id,f.user);assert.equal(f.balance(),100000);assert.equal(f.service.book(e.id,f.user).alreadyBooked,true);assert.equal(f.balance(),100000);
    f.service.unbook(e.id,f.user);assert.equal(f.balance(),200000);assert.throws(()=>f.service.unbook(e.id,f.user),/No active/);const b=f.service.book(e.id,f.user);assert.notEqual(a.entryId,b.entryId);assert.equal(f.balance(),100000);
    f.setTime(e.closes);assert.throws(()=>f.service.unbook(e.id,f.user),/closes/);f.service.tick();const d=f.service.detail(e.id,f.user.id).event;assert.equal(d.status,'locked');assert.equal(d.joined,100);assert.equal(d.humanCount,1);assert.equal(d.computerCount,99);assert.throws(()=>f.service.book(e.id,f.user),/closed/);assert.equal(f.balance(),100000);
  }finally{f.close();}
});
test('1000 seats fill with labelled computers, no fake entry-fee debits, no singleton tables',()=>{
  const f=fixture();try{const e=f.event('mega1000');f.service.adminAction({action:'fund-adjust',amount:100000000,note:'Test pool'},'owner');f.service.adminAction({action:'open',id:e.id},'owner');f.service.book(e.id,f.user);f.setTime(e.closes);f.service.tick();assert.equal(f.service.detail(e.id,f.user.id).event.computerCount,999);assert.equal(f.db.prepare("SELECT count(*) n FROM ledger WHERE kind='tournament_entry'").get().n,1);f.setTime(e.start);f.service.tick();const matches=[...f.games.values()].filter(g=>g.tournamentId===e.id);assert.equal(matches.length,167);assert.equal(matches.reduce((n,g)=>n+g.players.length,0),1000);assert.ok(matches.every(g=>g.players.length>=2&&g.players.length<=6));const count=matches.length;f.service.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM tour_matches WHERE event_id=?').get(e.id).n,count);assert.ok(f.service.detail(e.id,f.user.id).event.mine.gameId);}finally{f.close();}
});
test('three round ranking settles the published prize once, separate from 1.8x payout',()=>{
  const f=fixture();try{const e=f.event('classic100');f.service.adminAction({action:'fund-adjust',amount:100000000,note:'Test pool'},'owner');f.service.adminAction({action:'open',id:e.id},'owner');f.service.book(e.id,f.user);f.setTime(e.start);f.service.tick();
    for(let round=1;round<=3;round++){const matches=[...f.games.values()].filter(g=>g.tournamentId===e.id&&g.tournamentRound===round);assert.ok(matches.length);let n=0;for(const g of matches){for(const p of g.players)p.score=p.bot?100+(n++):0;g.status='finished';g.winnerId=g.players[0].id;f.service.recordMatch(g);f.service.recordMatch(g);}f.service.tick();}
    const detail=f.service.detail(e.id,f.user.id);assert.equal(detail.event.status,'finished');assert.equal(detail.event.mine.rank,1);assert.equal(detail.event.mine.played,3);assert.equal(detail.event.mine.prize,5000000);assert.equal(f.balance(),5100000);assert.equal(f.db.prepare("SELECT count(*) n FROM ledger WHERE kind='tournament_prize'").get().n,1);assert.equal(f.service.adminState().fund,95100000);f.service.tick();assert.equal(f.balance(),5100000);
  }finally{f.close();}
});
test('ties split paid rank positions, including a tie across the top-ten boundary',()=>{
  const entries=Array.from({length:12},(_,i)=>({id:String(i).padStart(2,'0'),score:i<9?i:9}));const ranked=rankEntries(entries,Array(10).fill(100));assert.equal(ranked.slice(9).reduce((n,r)=>n+r.prize,0),10000);assert.ok(ranked.slice(9).every(r=>r.rank===10));assert.equal(ranked.reduce((n,r)=>n+r.prize,0),100000);
});
test('restart recovers bookings and cancellation refunds once without retaining active matches',()=>{
  const f=fixture();try{const e=f.event('classic100');f.service.adminAction({action:'fund-adjust',amount:10000000,note:'Test pool'},'owner');f.service.adminAction({action:'open',id:e.id},'owner');f.service.book(e.id,f.user);f.setTime(e.start);f.service.tick();const recovered=createTournamentService(f.args);assert.equal(recovered.detail(e.id,f.user.id).event.mine.played,0);recovered.cancel(e.id);assert.equal(f.balance(),200000);assert.equal(recovered.adminState().fund,10000000);recovered.cancel(e.id);assert.equal(f.balance(),200000);assert.equal([...f.games.values()].filter(g=>g.tournamentId===e.id).length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM tour_matches WHERE event_id=? AND status='playing'").get(e.id).n,0);}finally{f.close();}
});
test('template edits cannot change already published prizes and missing start cancels safely',()=>{
  const f=fixture();try{const e=f.event('starter100');f.service.adminAction({action:'fund-adjust',amount:10000000,note:'Test pool'},'owner');f.service.adminAction({action:'open',id:e.id},'owner');f.service.book(e.id,f.user);const c={...DEFAULT_TOURNAMENTS[2],prizes:[6000,2500,1000,100,100,100,100,100,100,100]};f.service.adminAction({action:'template',template:c},'owner');assert.equal(f.service.detail(e.id,f.user.id).event.prizes[0],5000);assert.equal(f.service.list(f.user.id,'tomorrow').events.find(x=>x.template_id==='starter100')?.prizes?.[0]||f.service.list(f.user.id,'tomorrow').events.find(x=>x.id.endsWith('starter100')).prizes[0],6000);f.setTime(e.start+180000);f.service.tick();assert.equal(f.service.detail(e.id,f.user.id).event.status,'cancelled');assert.equal(f.balance(),200000);assert.throws(()=>validateTemplate({...c,prizes:Array(10).fill(-1)}),/prizes/);}finally{f.close();}
});

````


## `README.md`

````markdown
# WAR OF CARDS — ఫైనల్ డిజైన్ ప్రాజెక్ట్

ఈ ZIP ఒక ప్రత్యేక **WAR OF CARDS** ప్రాజెక్ట్. ఇప్పటికే ఉన్న TSB / Kreeda Lokam ఫైళ్లను దీనితో మార్చకండి. కొత్త ఫోల్డర్‌లో extract చేయండి.

## మొదట రన్ చేయడం

1. కంప్యూటర్‌లో **Node.js 24.x** ఇన్‌స్టాల్ చేసి ఉండాలి. [Official Node.js download](https://nodejs.org/en/download).
2. ZIP extract చేసి, `play-rummy` ఫోల్డర్‌ను VS Codeలో తెరవండి.
3. ఆ ఫోల్డర్ టెర్మినల్‌లో:

```bash
npm run setup
npm start
```

`setup` మీకోసం కొత్త Admin password తయారు చేసి టెర్మినల్‌లో చూపిస్తుంది. దాన్ని భద్రపరుచుకోండి. ముందే `.env` ఉంటే దాన్ని మార్చదు. Database మొదటిసారి తయారయ్యేటప్పుడు మాత్రమే ఈ credentialsతో admin create అవుతుంది.

| పేజీ | స్థానిక లింక్ |
|---|---|
| Customer | http://localhost:3000/ |
| Admin | http://localhost:3000/admin |

**Admin ID: `owner`**. Password: మీ కంప్యూటర్‌లో `npm run setup` చూపించినది. ఈ ZIPలో ముందే నిర్ణయించిన admin password లేదా customer accounts లేవు.

బయటి packages అవసరం లేదు; `npm install` అవసరం లేదు. Node.js built-in HTTP, crypto, SQLite ఉపయోగించాం. Frontend HTML/CSS/JavaScript; ఈ ప్రాజెక్ట్ React/Vite ఆధారితం కాదు.

## ముందుగా Adminలో చేయాల్సినవి

1. Payment Settingsలో బ్యాంక్, UPI, QR, support నంబర్ ఇవ్వండి.
2. Bonus Settingsలో శాతాలు / promo code పరిశీలించండి. ప్రారంభ కోడ్ `PLAY10`.
3. Sign Up Requestsలో వచ్చిన రిక్వెస్ట్‌కు **Create & Send ID** నొక్కండి.
4. Customer page అదే browserలో తెరిచి ఉంటే request boxలో **Reveal login details once** వస్తుంది.
5. Customer మొదటిసారి login అయ్యాక తప్పనిసరిగా password మార్చాలి.
6. Customers / IDsలో నేరుగా ID సృష్టించవచ్చు. Coin Managementలో కారణంతో balance add/remove చేయవచ్చు.

## సిద్ధమైన కస్టమర్ ఫ్లో

- Before Login: WAR OF CARDS / Play Rummy, Win Money, Log In, Sign Up, Welcome 10%, Promo 10%, Losing 10%.
- Losing card బయట 10% మాత్రమే. లోపల ₹10,000 net settled lossesకి ₹1,000 వివరాలు.
- Sign Up websiteలోనే జరుగుతుంది; WhatsApp తెరవదు.
- Userకి ప్రత్యేక, రహస్య request cookie ఉంటుంది. వారి ID / temporary password అదే request boxలో మాత్రమే వస్తాయి. Name ఆధారంగా replies match చేయము.
- Temporary password databaseలో encryptedగా ఉంటుంది; reveal చేసిన తర్వాత delivery తొలగుతుంది. Password hashes మాత్రమే user recordలో నిల్వ ఉంటాయి.
- Signup request browser cookie ఏడు రోజులు ఉంటుంది. Cookie తొలగిస్తే పాత request box మళ్లీ గుర్తించలేం; adminని సంప్రదించి password reset చేయించాలి.
- After Login నేరుగా tables lobby. My Games, Wallet, Support, Rules, Bonus info, Change Password, Logout.

## టేబుల్స్ — ఫైనల్ అమరిక

పైన నాలుగు tabs: **Point Rummy 101**, **Point Rummy 201**, **Pool Rummy**, **Deal Rummy**.

ప్రతి tabలో 80 tables; నాలుగింటికి కలిపి 320 table definitions. ఖాళీ tablesలో ఆటలు ప్రారంభం కావు.

| Entry | 2 Players | 6 Players | మొత్తం |
|---|---|---|---:|
| ₹10 | T1–T5 | T1–T5 | 10 |
| ₹20 | T1–T5 | T1–T5 | 10 |
| ₹50 | T1–T5 | T1–T5 | 10 |
| ₹100 | T1–T5 | T1–T5 | 10 |
| ₹250 | T1–T5 | T1–T5 | 10 |
| ₹500 | T1–T5 | T1–T5 | 10 |
| ₹1,000 | T1–T5 | T1–T5 | 10 |
| ₹2,000 | T1–T5 | T1–T5 | 10 |

ఫైనల్ screenshotలో ఉన్నట్టుగా compact white boxes, ఒక్కో capacityకి ఒక rowలో ఐదు buttons. Screen height బట్టి మిగతా amounts కోసం scroll. రెండు capacitiesలో T1 నుంచి numbering మొదలవుతుంది; లోపల IDsకి mode/stake/capacity కూడా ఉంటాయి కాబట్టి clash కాదు.

## గేమ్ ప్రారంభం / కంప్యూటర్ ప్లేయర్లు

- మొదటి human చేరినప్పుడు మాత్రమే countdown మొదలు.
- 2-player table: మొత్తం 15 seconds. తొలి 10 secondsలో human join చేయవచ్చు. 10 seconds తర్వాత ఖాళీ seatకి computer. 15 secondsకి deal.
- 6-player table: మొత్తం 30 seconds. తొలి 25 seconds human join window. ఆ తర్వాత ఖాళీ seats కంప్యూటర్లతో నింపి 30 secondsకి deal.
- 2,000 వేర్వేరు synthetic Indian-style names: 100 first names × 20 surnames. మగ / ఆడ పేర్లు కలిపి ఉన్నాయి. ఇవి నిజమైన customer accounts కాదు; వ్యక్తుల profile data సేకరించలేదు.
- ప్రతి computer seatపై **Computer** గుర్తు ఉంటుంది. Computerకి తన hand మాత్రమే ఆధారంగా move selection; గెలుపు ముందే fix చేయలేదు.
- Human వచ్చేవరకు computers తమంతట తామే కొత్త game మొదలుపెట్టవు.
- Human waitingలో leave అయితే entry debit కాదు. చివరి human leave అయితే waiting room మూసివేస్తాం.

## ఆట నియమాల అమలు

- 13 cards, రెండు standard decks + నాలుగు printed jokers.
- Draw → Discard; valid hand ఉంటే automatic declaration. Declare / Showలో తప్పు hand submit చేస్తే వెంటనే **80 points** cumulative scoreకు యాడ్ అవుతాయి. ఆ player అదే roundలో కొనసాగుతాడు; drop / out చేయము. Cards, turn, timer అలాగే ఉంటాయి. ఇది ₹80 wallet debit కాదు. సాధారణ discardకు ఈ penalty లేదు. Wrong declaration తర్వాత సరైన discard లేదా మరో declaration చేయవచ్చు. ప్రతి కొత్త తప్పు attemptకి 80; అదే request IDని replay చేస్తే మళ్లీ penalty ఉండదు.
- పూర్తి 13 cards groupsలో ఉండాలి; కనీసం రెండు sequences, వాటిలో ఒక pure sequence.
- Same-suit sequences, same-rank different-suit sets, printed/wild jokers, Ace low లేదా high; K–A–2 wrapping లేదు.
- Wild rank తన సహజ స్థానంలో pure sequenceలో ఉపయోగించవచ్చు.
- Discard pile నుంచి joker తీసుకోలేరు. Discard నుంచి తీసుకున్న అదే cardను ఆ turnలో వెనక్కి discard చేయలేరు.
- ప్రతి turn 30 seconds; timeout అయితే draw + auto-discard.
- Drop: table మొదటి turnకు ముందు 20 points; ఆ తర్వాత 40. ప్రతి hand deadwood cap 80.
- **మీరు కోరిన lobby పేర్లనే ఉంచాం:** Point Rummy 101 / 201 tabsలో 101 / 201 cumulative elimination series వాడాం. Pool default 101. Deal Rummy రెండు deals; తక్కువ total points గెలుపు. ఇది traditional per-point cash settlement కాదు.
- Dealsలో lowest-score tie అయితే human entries తిరిగి జమ. గేమ్ roundకి 200 turns దాటితే పూర్తి game drawగా entries refund.
- 101 / 201 series మధ్యలో round results 8 seconds చూపించి తదుపరి deal.
- ఒక accountకు ఒక active game. Seriesలో eliminated అయిన player final result వరకు అదే gameకి సంబంధించినవాడిగా ఉంటుంది.

## Wallet లెక్కలు

అమౌంట్లు databaseలో integer paiseగా నిల్వ ఉంటాయి. Frontend amountతో balance మార్చలేరు.

| సంఘటన | ₹100 entry ఉదాహరణ |
|---|---:|
| Game మొదలయ్యేటప్పుడు debit | −₹100 |
| Game series / deals winnerకి credit | +₹180 |
| Winner నికర లాభం | ₹80 |
| Loser నికర loss | ₹100 |
| Cancel / draw refund | +₹100 |

6-player tableలో కూడా winnerకి తన entryకి **1.8× fixed payout** మాత్రమే; అందరి stakes కలిపిన prize pool కాదు. మధ్యలో ప్రతి roundకి మళ్లీ stake debit / payout జరగదు.

Deposit: amount + proof PNG/JPEG (max 2 MB) + UTR → pending → Admin Approve/Reject. Approved deposit మాత్రమే balanceకి జమ. ఒకే UTRని మళ్లీ submit చేయలేరు.

Withdrawal: holder / bank / account / confirm account / IFSC / login password → amount hold → Admin Approve/Reject. Reject అయితే hold తిరిగి జమ. Approve అయితే wallet నుంచి ఇప్పటికే hold అయిన amountపై మళ్లీ debit లేదు. Minimum deposit ₹100, withdrawal ₹300; admin settingsలో మార్చవచ్చు.

**Bank / UPI transfer స్వయంగా జరగదు.** Admin bank payment విడిగా చేసి withdrawal decision నమోదు చేయాలి. ఈ softwareలో bank, payment gateway లేదా payout provider కనెక్షన్ లేదు. స్థానిక wallet records మాత్రమే నిర్వహిస్తుంది.

## బోనస్‌లకు ఈ వెర్షన్‌లో ఎంచుకున్న విధానం

ఈ లెక్కల కాలవ్యవధి / deposit basis పూర్తిగా నిర్ధారించలేదు కాబట్టి స్పష్టమైన ప్రారంభ defaults పెట్టాం:

- Welcome: మొదటి approved depositపై 10%, accountకి ఒక్కసారి.
- Promo: deposit requestలో సరైన promo code ఇచ్చినప్పుడు 10%, accountకి ఒక్కసారి.
- రెండు conditions సరిపోతే ఒక depositపై రెండూ రావచ్చు.
- Losing: జీవితకాల cumulative **net settled loss progress**. Loss పెంచుతుంది; game profit progress తగ్గిస్తుంది, zero కిందకి పోదు. ₹10,000 చేరితే user claim చేయవచ్చు; 10% = ₹1,000. Claim ఒక్క threshold consume చేస్తుంది. మళ్లీ ₹10,000 progress ఏర్పడితే మళ్లీ eligible.
- Bonuses walletకి నేరుగా credit అవుతాయి. వేరే bonus wallet / wagering restrictions ఈ వెర్షన్‌లో లేవు.

ఈ defaultsను launch ముందు మీ business rules ప్రకారం పరిశీలించండి. శాతాలు, threshold, promo code Adminలో మార్చవచ్చు.

## అడ్మిన్‌లో ఉన్నవి

Overview, Sign Up Requests, Customers / IDs, Deposit Requests, Withdrawals, Coin Management, Payment Settings, Bonus Settings, Games / Tables, Transactions, Admin Settings / Audit Log.

Block / unblock, reset password, revoke sessions, table pause / resume, active game cancel & refund ఉన్నాయి. Wallet operationsకు audit ఉంది; duplicate request decision రెండుసార్లు credit/refund చేయదు.

## స్క్రీన్ రొటేషన్

Website / lobby portraitలో responsiveగా ఉంటాయి. Table open చేస్తే portrait phoneలో table containerను landscapeగా చూపించే CSS fallback ఉంది. Rotate button fullscreen + orientation lockను browser అనుమతిస్తే వాడుతుంది; లేకపోతే local rotated view. Phone అడ్డంగా తిప్పితే native landscape layout. అన్ని browsers OS orientation lockకి అనుమతించవు.

## ఇంకా కనెక్ట్ చేయనివి

- **Automatic WhatsApp notifications:** అమలు చేయలేదు. Signup request Admin Panelకి, reply customer boxకి పనిచేస్తాయి. Official WhatsApp account/API/eligibility configuration ఇంకా అవసరం. ఎటువంటి WhatsApp సందేశాలు ఈ app పంపదు.
- Bank transfer, live payment gateway / payout provider, OTP / SMS లేవు.
- ఈ build ఒక single-server code release. High-concurrency load / external security audit / all-phone testing పూర్తికాలేదు.

## డేటా / హోస్టింగ్

`data/play-rummy.sqlite`, WAL/SHM files, `data/delivery.key` మరియు `.env` private. Public folder బయట ఉంటాయి. Databaseతో పాటు `delivery.key` కూడా backup చేయాలి; అది పోతే ఇంకా reveal చేయని signup passwords decrypt కావు. Runtime files ZIPలో లేవు.

Local installకు SQLite సరిపోతుంది. Render లేదా ఇతర hostలో **persistent disk**కి DATA_DIR ఇవ్వాలి; తాత్కాలిక filesystemపై production customer data నిల్వ చేయకండి. ఒక instance మాత్రమే run చేయండి; multi-instance matchmaking ఈ codeలో లేదు.

Deployment environment: Node 24.x, start `npm start`, persistent `DATA_DIR`, strong `ADMIN_ID` / `ADMIN_PASSWORD` before first start. HTTPS reverse proxy మీ నియంత్రణలో ఉంటే `TRUST_PROXY=true`; `NODE_ENV=production`. Copy `.env.example` only as a reference; secretsని repositoryలో commit చేయకండి. మీ existing TSB PostgreSQLకి ఈ project connect కాదు; ఇది వేరే SQLite database.

## పరీక్షలు

```bash
npm run check
npm test
```

Tests isolate their own temporary database. They cover table counts / labels, 2,000 names, deck integrity, meld validation, private hands, timers, two deals, signup delivery isolation, password gate, admin authorization, wallet decisions / replay protection, withdrawal hold/refund, paused tables, labelled bot admission, stake debit, cancellation refund, persistence, CSRF checks, and ₹100 → ₹180 winning settlement through the normal Declare endpoint.

ఈ వెర్షన్‌లో browser QA scopeను VALIDATION.mdలో చూడండి. Physical-phone rotation మరియు live multi-user load verification పూర్తికాలేదు.

## Full-file copy–paste

ఈ ZIPలో ఉన్న `War_Of_Cards_Copy_Paste.md`లో ప్రతి source file పూర్తి code ఉంటుంది. కొత్త file సృష్టించండి; లేదా ఆ projectలో అదే file ఇప్పటికే ఉంటే **పాత content మొత్తం Delete → పూర్తి code Copy → Paste → Save**. మధ్యలో చిన్న snippets కలపవద్దు.

Sources used for implementation reference: [Node 24 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html). Indian-name usage checked via [Behind the Name](https://www.behindthename.com/support/usage.php?code=ind); the name combinations in this project were generated synthetically, not copied customer identities.

## ఫైనల్ విజువల్ లాక్ (8 November 2026)

- Site name: **WAR OF CARDS**. Caption: **Play Rummy, Win Money**.
- Before Login: final gold Ace / purple mounted-warriors logo, black background, gold accents, blue/purple bonus/game cards. Requested artwork line: “WORLD’S FIRST GAME”; ఇది supplied marketing copy మాత్రమే, independent first-in-world verification చేయలేదు.
- After Login: అదే compact logo; **plain purple + maroon** controls, white compact table containers, black background. Gold UI borders లేవు; gold logoలో మాత్రమే ఉంటుంది. Boxes ఒకే row arrangementలో; capacities రెండింటికీ numbering T1–T5 (imageలో ఉన్న T6–T10 label పాతది).
- In Game: landscape charcoal oval table, maroon rail, purple outlines, 2 లేదా 6 seats, private hand, Sort / Drop / Discard / Declare. Computer seatsపై గుర్తు.
- Wrong Declare: **+80 score points immediately, player continues in SAME round**. Series thresholdsను round result వచ్చినప్పుడు మాత్రమే apply చేస్తాం. A score penalty itself never drops or skips the player.

కొత్త logo asset `public/assets/brand-logo.png` ZIPలో ఉంది. Manual copy–pasteలో ఆ image fileను కూడా అదే pathలో ఉంచాలి.

## Tournament extension — Version 1.2.0

My Games / Wallet మధ్యలో glowing **Tournament** button ఉంది. Today / Tomorrow booking, రోజుకు IST 06:00 / 09:00 / 12:00 / 15:00 / 18:00 / 21:00, ప్రతి సమయానికి మూడు profiles. Full prize tables, provisional lower-rank prizes, initial 3-round format, admin prize-reserve opening and operational limits కోసం **TOURNAMENTS.md** చదవండి. `npm test`: 18 passed.

ఇప్పటికే install చేసి ఉంటే: మీ private `data/` directory, `delivery.key`, `.env` backup ఉంచండి. ఆ మూడు overwrite చేయకుండా ఈ ZIPలోని source files మొత్తాన్ని replace చేయండి. Database tables మొదటి startupలో స్వయంగా add అవుతాయి. కొత్త install అయితే `npm run setup` తర్వాత `npm start`.

````


## `TOURNAMENTS.md`

````markdown
# WAR OF CARDS 1.2.0 — Tournament setup

## Final navigation

Home → My Games → **Tournament** → Wallet → Support.

Only Tournament has a slow neon/radium glow. Reduced-motion browser settings stop its animation. Existing lobby boxes retain their plain purple/maroon design.

## Daily schedule (Asia/Kolkata / IST)

Six start times: **06:00, 09:00, 12:00, 15:00, 18:00, 21:00**.

All THREE profiles start together at every time: **18 tournament instances per day**. Today and tomorrow are visible. Tomorrow's events can be booked today once the admin reserves their prize pool and opens registration.

Human registration and cancellation close **exactly 10 minutes before start**. Example: 06:00 start → 05:50 cutoff. At cutoff remaining seats are filled by labelled Computers; cards are dealt at the scheduled start. One customer can book only one profile at a given start time.

## Prize defaults

| Profile | Entry | Players | 1st | 2nd | 3rd | 4th | 5th–10th | Total prizes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Classic 100 | ₹1,000 | 100 | ₹50,000 | ₹25,000 | ₹10,000 | ₹5,000 | ₹1,000 each | ₹96,000 |
| Mega 1000 | ₹1,000 | 1,000 | ₹5,00,000 | ₹2,50,000 | ₹1,00,000 | ₹10,000 | ₹10,000 each | ₹9,20,000 |
| Starter 100 | ₹100 | 100 | ₹5,000 | ₹2,500 | ₹1,000 | ₹100 | ₹100 each | ₹9,200 |

**Classic 100 ranks 5–10 at ₹1,000 each is a provisional default** because the exact lower-rank breakdown was not confirmed. Admin can change all ten prizes before an event opens. Once registration is open, its published fee, capacity, format and prizes stay frozen.

## Match format defaults

The requested registration and prize plan did not define a knockout progression. This version uses **3 timed scoring rounds**, each up to **8 minutes**. These are explicit initial defaults; admin can choose 1–5 rounds and 1–20 minutes per round on unopened events.

- Each participant plays one 13-card table per round; tables contain 2–6 players, never a one-player bye at configured capacities.
- Players are randomly shuffled across tables at each round.
- Everyone stays in the event for all configured rounds; this is a scoring league, not a knockout bracket.
- A valid declaration finishes that table's hand. The declarer scores 0 deadwood; other players receive their hand/drop points.
- If time expires or 200 turns are reached, remaining hand points are recorded. If a player has drawn a 14th card, the final drawn card is excluded from timeout hand scoring.
- Wrong Declare / Show adds **80 points immediately** and the player continues the same hand, with their turn and cards intact.
- Lowest total points after all rounds ranks first. Tied players share the combined prizes for the affected rank positions. A tie spanning rank 10 can therefore produce more than ten paid people; total payout stays within the published pool.
- Tournament prizes follow this prize table. The regular game **1.8× payout does not apply** to tournament hands.
- A completed table's screen links back to the tournament, where the next table appears after all tables in that round finish. Rejoin through Tournament → My Booking / Enter → Enter My Table.
- Finish ordinary games before the scheduled tournament start; booked tournament seats auto-start even if the browser is closed. Turn timeouts still apply.

## Computer seats and funding

The name pool now has **2,000 unique synthetic Indian-style names** (100 first names × 20 surnames). They are names for Computer seats, not real accounts. Computer seats are labelled in the lobby, leaderboard and table; computer-vs-computer hands use the same dealt-card engine, with a lightweight strategy based only on their own cards. Prize rankings are computed from match scores, not assigned by admin.

**Computers do not contribute paid entry fees.** Before opening an event, Admin → Tournaments must reserve its full prize pool from the tournament prize reserve. This avoids treating invented computer fees as funds for real players' prizes.

1. Admin → Tournaments → Reserve adjustment: add the intended backing amount with a reason. This records an internal wallet adjustment; it does not debit a bank account.
2. Click **Reserve & Open** for each event to be offered. Booking is unavailable until its prize pool has been reserved.
3. A human booking debits their entry once. Cancellation before cutoff restores it once; rebooking creates a fresh booking.
4. At completion, human prizes are credited once from that reserved pool. Computer awards are not paid to fake wallets. Unused reserve and collected human entries return to the operator's tournament reserve ledger.
5. Admin event cancellation refunds human entries and releases the reserve. Empty events with no human registrations are cancelled instead of running all-computer prize events.

Existing pending human entry holds remain refundable; the admin's free reserve balance cannot withdraw money already held for an opened event. Reserve changes, event opening and cancellation are audited.

## Reliability and operational limits

- Keep this Node server running continuously. The app's server scheduler is responsible for creating today's/tomorrow's slots, cutoff, start, timed scoring and settlement; there is no separate ChatGPT reminder/automation.
- Persistent SQLite data stores bookings, games, scores, processed declarations, reserve ledger and prize ledger. Restart does not duplicate paid entries or prizes.
- If the server misses an unopened event's start by more than two minutes, that event is cancelled and human fees refunded. Started games resume from stored state; elapsed turn/round deadlines still apply.
- This remains a **single-process server**. A 1,000-seat event's creation and table partitioning were tested; concurrent live play by 1,000 real browser clients was **not load tested**. Do that capacity validation before a live large event.
- Bank transfers, payment gateways, WhatsApp/SMS and identity verification are still not connected. This build records app wallet entries and admin decisions only.

## Included verification

`npm run check` and `npm test`: **18 tests, all passed**. Coverage includes IST scheduling, 18 events/day, tomorrow visibility, reserve gating, duplicate bookings, cancellation/rebooking, exact cutoff, 999 labelled Computer seats for one human in a 1,000-seat event, 167 correctly sized tables, three-round ranking, one-time prize credit, ties, restarts, refunds, frozen published prize tables, role checks and the existing rummy/wallet suite.

````


## `VALIDATION.md`

````markdown
# WAR OF CARDS 1.2.0 — Validation

Validated on Node.js 24.22.1, 8 November 2026.

- `npm run check`: passed (server.js, game.js, public/app.js syntax).
- `npm test`: 18 tests passed, 0 failed.
- Invalid Declare / Show adds 80 points immediately and leaves the player active in the SAME round: no drop, elimination, card removal, turn advancement, or timer extension.
- A normal non-winning discard does not add an 80-point penalty.
- Duplicate declaration request IDs do not apply the penalty again, including after a server restart.
- A valid declaration after the penalty still works; a deterministic two-deal fixture verifies score remains 80 and the correct ₹100 → ₹180 wallet settlement occurs once.
- Other checks include 320 table definitions (80 per mode), T1–T5 per capacity, deck / meld integrity, 2,000 synthetic names, private opponent hands, signup reply isolation, mandatory password change, admin authorization, request replay protection, withdrawal hold/refund, bot admission timing, cancellations and durable balances.
- Browser inspected: final public homepage, logo, gold/blue/purple landing theme and visible labels. Authenticated browser screens were not manually inspected; their backend flows were tested through HTTP.
- Mobile landscape and portrait CSS are included. Physical-phone fullscreen / orientation behavior and concurrent multiplayer load were not tested.
- No real bank transfers, WhatsApp messages or deployment were performed.

The mockup image is a visual guide. This implementation uses real HTML controls rather than a screenshot as the interface. Lobby labels use T1–T5 for both capacities, as requested earlier, even though the supplied reference contains legacy T6–T10 labels.

Tournament validation: See TOURNAMENTS.md. Seven dedicated tournament tests plus HTTP tournament booking/admin/refund assertions are included. The 1,000-seat test covers partitioning into 167 tables; this is not a 1,000-client concurrent load test. New authenticated tournament screens were not manually browser-tested.

````
