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
