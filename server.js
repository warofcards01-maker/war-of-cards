import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { pool, initializeDatabase, closeDatabase } from './database.js';
import { TABLES, MODES, STAKES, tableById, newGame, fillComputers, startRound, drawCard, discardCard, declareHand, chooseDiscard, chooseTournamentDiscard, nextTurn, activePlayers, finishRound, viewGame, analyze } from './game.js';
import {createTournamentService} from './tournaments.js';

try { process.loadEnvFile(); } catch(e) { if(e.code!=='ENOENT')throw e; }
const ROOT=path.dirname(fileURLToPath(import.meta.url));
// Key for one-time login details. Stable across deploys because it comes from the environment, not from a local file.
const secret=createHash('sha256').update(String(process.env.DELIVERY_KEY||process.env.DATABASE_URL||'')).digest();
await initializeDatabase();

// ---- PostgreSQL helpers -------------------------------------------------
// Inside tx() every query automatically uses that transaction's connection.
const als=new AsyncLocalStorage();
const pgSql=sql=>{let n=0;return sql.replace(/\?/g,()=>'$'+(++n));};
const conn=()=>als.getStore()||pool;
const q=async(sql,...args)=>(await conn().query(pgSql(sql),args)).rows[0];
const all=async(sql,...args)=>(await conn().query(pgSql(sql),args)).rows;
const run=async(sql,...args)=>conn().query(pgSql(sql),args);
async function tx(fn){
  if(als.getStore())return fn();
  const client=await pool.connect();
  try{await client.query('BEGIN');const r=await als.run(client,fn);await client.query('COMMIT');return r;}
  catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
  finally{client.release();}
}
// One state-changing request or game tick at a time, exactly like the old single-process database.
let chain=Promise.resolve();
function exclusive(fn){const p=chain.then(()=>fn());chain=p.catch(()=>{});return p;}

const hash=s=>createHash('sha256').update(s).digest('hex');
const now=()=>Date.now();
function fail(message,status=400){const e=Error(message);e.status=status;throw e;}
function gameTry(fn){try{return fn();}catch(e){fail(e.message);}}
function passwordHash(p){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;}
function passwordOK(p,stored){try{const [salt,v]=stored.split(':');return timingSafeEqual(Buffer.from(v,'hex'),scryptSync(p,salt,64));}catch{return false;}}
function validPassword(p){if(typeof p!=='string'||p.length<12||p.length>128)fail('Use a password of 12–128 characters.');}
function encrypt(v){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',secret,iv);return Buffer.concat([iv,c.update(v),c.final(),c.getAuthTag()]).toString('base64');}
function decrypt(v){const b=Buffer.from(v,'base64'),c=createDecipheriv('aes-256-gcm',secret,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();}
async function audit(actor,action,details){await run('INSERT INTO audit(id,actor,action,details,created) VALUES(?,?,?,?,?)',randomUUID(),actor,action,JSON.stringify(details),now());}
const DEFAULTS={welcome:10,promo:10,losing:10,lossThreshold:10000,promoCode:'PLAY10',bankName:'',holderName:'',accountNumber:'',ifsc:'',upi:'',qr:'',support:process.env.SUPPORT_NUMBER||'',minDeposit:100,minWithdrawal:300};
for(const [k,v]of Object.entries(DEFAULTS))await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',k,JSON.stringify(v));
async function settings(){return Object.fromEntries((await all('SELECT key,value FROM settings')).map(r=>[r.key,JSON.parse(r.value)]));}
function publicUser(u){return {id:u.id,name:u.name,username:u.username,mobile:u.mobile,role:u.role,balance:u.balance,mustChange:!!u.must_change,blocked:!!u.blocked,lossProgress:u.loss_progress};}
async function credit(id,amount,kind,note,ref=randomUUID()) {
  if(!Number.isSafeInteger(amount)||!amount)fail('Invalid ledger amount.');
  if(await q('SELECT 1 FROM ledger WHERE ref=?',ref))return false;
  const u=await q('SELECT * FROM users WHERE id=?',id);if(!u||u.balance+amount<0)fail('LOW BALANCE');
  await run('UPDATE users SET balance=balance+? WHERE id=?',amount,id);
  await run('INSERT INTO ledger(id,user_id,amount,kind,note,ref,created) VALUES(?,?,?,?,?,?,?)',randomUUID(),id,amount,kind,note,ref,now());return true;
}
async function createUser({name,mobile='',username,password,role='customer',mustChange=true}) {
  if(typeof name!=='string'||name.trim().length<2||name.length>80)fail('Enter a valid name.');
  if(!/^[a-zA-Z0-9_]{4,24}$/.test(username||''))fail('User ID must contain 4–24 letters, digits or underscores.');
  validPassword(password);
  if(await q('SELECT 1 FROM users WHERE username=?',username.toLowerCase()))fail('User ID already exists.');
  const id=randomUUID();await run('INSERT INTO users(id,name,mobile,username,password,role,must_change,created) VALUES(?,?,?,?,?,?,?,?)',id,name.trim(),mobile,username.toLowerCase(),passwordHash(password),role,Number(mustChange),now());return q('SELECT * FROM users WHERE id=?',id);
}
if(!(await q("SELECT 1 FROM users WHERE role='admin'"))) {
  if(!process.env.ADMIN_ID||!process.env.ADMIN_PASSWORD)throw Error('First launch: set ADMIN_ID and ADMIN_PASSWORD in the environment.');
  await createUser({name:'Administrator',username:process.env.ADMIN_ID,password:process.env.ADMIN_PASSWORD,role:'admin',mustChange:false});
}
const games=new Map((await all("SELECT state FROM games WHERE status!='finished'")).map(r=>{const g=JSON.parse(r.state);return[g.id,g];}));
const saveGame=g=>run('INSERT INTO games(id,table_id,status,state,created) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state',g.id,g.tableId,g.status,JSON.stringify(g),g.created);
async function findGame(id){const g=games.get(id);if(g)return g;const row=await q('SELECT state FROM games WHERE id=?',id);return row?JSON.parse(row.state):null;}
const tournamentService=await createTournamentService({db:{q,all,run},credit,tx,audit,games,saveGame});
async function roundEnd(g,winner){finishRound(g,winner);if(g.status==='finished'){if(g.tournamentId)await tournamentService.recordMatch(g);else await settle(g);}await saveGame(g);}
async function settle(g){
  if(g.settled)return;
  await tx(async()=>{
    const winner=g.players.find(p=>p.id===g.winnerId);
    for(const p of g.players.filter(p=>!p.bot)) {
      if(g.tie||g.cancelled){await credit(p.id,g.stake*100,'refund','Game refunded',`${g.id}:refund:${p.id}`);continue;}
      const won=winner?.id===p.id;
      if(won)await credit(p.id,g.stake*180,'game_win','Stake returned + 80% profit',`${g.id}:win:${p.id}`);
      await run('UPDATE users SET loss_progress=GREATEST(0,loss_progress+?) WHERE id=?',won?-g.stake*80:g.stake*100,p.id);
    }
    g.settled=true;await saveGame(g);
  });
}
async function cancel(g,reason){if(g.tournamentId){await tournamentService.cancel(g.tournamentId,reason);return;}g.status='finished';g.cancelled=true;g.log.push(reason);await settle(g);await saveGame(g);}
let gameCursor=0,ticking=false;
async function gameTick() {
  await tournamentService.tick();
  const work=[...games.values()],begin=now();let botMoves=0;
  for(let i=0;i<work.length;i++) {const g=work[(gameCursor+i)%work.length];
    try {
      if(g.status==='finished'){games.delete(g.id);continue;}
      if(g.status==='waiting') {
        // Do not add computers to empty rooms. Humans join during the first 10/25 seconds.
        if(now()>=g.deadline-5000&&g.players.length<g.capacity){fillComputers(g);await saveGame(g);}
        if(now()>=g.deadline) {
          await tx(async()=>{for(const p of g.players.filter(p=>!p.bot)){const u=await q('SELECT * FROM users WHERE id=?',p.id);if(!u||u.blocked||u.balance<g.stake*100)fail('A player has insufficient balance or is blocked.');await credit(p.id,-g.stake*100,'game_stake',`${g.tableId}`,`${g.id}:stake:${p.id}`);}startRound(g);await saveGame(g);});
        }
      } else if(g.status==='roundOver'&&now()>=g.deadline){startRound(g);await saveGame(g);}
      else if(g.status==='playing') {
        if(g.tournamentId&&now()>=g.hardDeadline){await tournamentService.expireMatch(g);continue;}
        const p=g.players[g.turn];
        if((p.bot&&now()>=g.nextBotAt)||(!p.bot&&now()>=g.turnDeadline)) {
          if(p.bot&&g.tournamentId&&now()-begin>80)continue;
          if(!p.drawn)drawCard(g,p,'deck');
          const selected=p.bot?(g.tournamentId?chooseTournamentDiscard(g,p):chooseDiscard(g,p)):p.hand.filter(c=>c.id!==p.pickedDiscard).at(-1).id;
          const won=discardCard(g,p,selected);
          g.log.push(`${p.name}${p.bot?' (Computer)':''} ${p.bot?'played':'timed out; auto-discarded'}.`);
          if(won)await roundEnd(g,p.id);else{nextTurn(g);await saveGame(g);}if(p.bot)botMoves++;
        }
        if(g.status==='playing'&&g.turns>=200) {
          if(g.tournamentId){await tournamentService.expireMatch(g);continue;}
          // Exhaustion is a draw; do not choose a winner or deduct a second stake.
          g.tie=true;g.status='finished';g.log.push('Turn limit reached. All human stakes refunded.');await settle(g);await saveGame(g);
        }
      }
    } catch(e) {
      // Failed admission has no debit, because admission is atomic. Other faults refund safely.
      try{
        if(g.status==='waiting'){g.status='finished';g.cancelled=true;g.settled=true;g.log.push(e.message);await saveGame(g);}
        else {console.error('Game recovery',g.id,e.message);await cancel(g,'Game interrupted; stakes refunded.');}
      }catch(e2){console.error('Game recovery failed',g.id,e2.message);}
    }
  }
  gameCursor=(gameCursor+Math.max(1,botMoves))%Math.max(1,work.length);
}
const ticker=setInterval(()=>{
  if(ticking)return;ticking=true;
  exclusive(gameTick).catch(e=>console.error('Game tick failed:',e.message)).finally(()=>{ticking=false;});
},500);

const rate=new Map();
function limit(key,max=12){const t=now(),old=rate.get(key);const r=old&&old.until>t?old:{count:0,until:t+60000};r.count++;rate.set(key,r);if(r.count>max)fail('Too many attempts. Try again in one minute.',429);}
// Real visitor address. Behind Render's proxy every request shares the proxy address, so use X-Forwarded-For when TRUST_PROXY=true.
function clientIp(req){if(process.env.TRUST_PROXY==='true'){const f=req.headers['x-forwarded-for'];if(f)return String(f).split(',')[0].trim();}return req.socket.remoteAddress;}
setInterval(()=>{for(const[k,v]of rate)if(v.until<now())rate.delete(k);run('DELETE FROM sessions WHERE expires<?',now()).catch(e=>console.error('Session cleanup failed:',e.message));},60000).unref();
function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1);}
function secure(req){return !!req.socket.encrypted||(process.env.TRUST_PROXY==='true'&&req.headers['x-forwarded-proto']==='https');}
function setCookie(req,res,name,value,age=86400){res.setHeader('Set-Cookie',`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure(req)?'; Secure':''}`);}
// Admin and customer logins use separate cookies, so they never mix in one browser.
// The page tells the server which area it belongs to with the X-Area header.
const areaOf=req=>{const h=req.headers['x-area'];if(h==='admin'||h==='customer')return h;try{return new URL(req.headers.referer||'','http://x').pathname.startsWith('/admin')?'admin':'customer';}catch{return 'customer';}};
const cookieFor=area=>area==='admin'?'pr_admin':'pr_session';
async function sessionFor(token,area){if(!token)return null;const u=await q('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.blocked=0',hash(token),now());if(!u)return null;if((area==='admin')!==(u.role==='admin'))return null;return u;}
function session(req){const area=areaOf(req);return sessionFor(cookie(req,cookieFor(area)),area);}
async function requireUser(req,admin=false,allowChange=false){const u=await session(req);if(!u)fail('Please log in.',401);if(admin&&u.role!=='admin')fail('Admin access required.',403);if(u.must_change&&!allowChange)fail('Change your temporary password first.',403);return u;}
async function loginSession(req,res,u){const token=randomBytes(32).toString('hex');await run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)',hash(token),u.id,now()+86400000);setCookie(req,res,cookieFor(u.role==='admin'?'admin':'customer'),token);}
async function body(req){let size=0,data=[];for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024)fail('Upload is too large.',413);data.push(chunk);}try{const value=JSON.parse(Buffer.concat(data).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))fail('JSON object required.');return value;}catch{fail('Invalid JSON object.');}}
function amount(v,min=1,max=1000000){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||Math.abs(v*100-Math.round(v*100))>0.00001)fail(`Amount must be ₹${min}–₹${max}, with at most two decimals.`);return Math.round(v*100);}
function text(v,max=200){return typeof v==='string'?v.trim().slice(0,max):'';}
function proofInfo(data){if(!data)return{bytes:null,mime:null};const m=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(data);if(!m)fail('Proof must be a PNG or JPEG image.');const b=Buffer.from(m[2],'base64');if(b.length>2*1024*1024)fail('Proof must be less than 2 MB.');if(m[1]==='image/png'&&!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('Invalid PNG.');if(m[1]==='image/jpeg'&&(b[0]!==255||b[1]!==216||b[2]!==255))fail('Invalid JPEG.');return{bytes:b,mime:m[1]};}
function requestView(r){return {...r,proof:undefined,hasProof:!!r.mime,details:JSON.parse(r.details||'{}')};}
// Request columns without the proof image, which can be up to 2 MB per row.
const REQUEST_COLUMNS='r.id,r.user_id,r.kind,r.amount,r.status,r.details,r.mime,r.created,r.decided';

async function api(req,res,url) {
  const method=req.method;
  if(method!=='GET') {
    if(req.headers['x-play-rummy']!=='1')fail('Missing request verification.',403);
    if(req.headers['sec-fetch-site']==='cross-site')fail('Cross-site request rejected.',403);
    if(req.headers.origin) {
      try{if(new URL(req.headers.origin).host!==req.headers.host)fail('Cross-site request rejected.',403);}catch(e){if(e.status)throw e;fail('Invalid origin.',403);}
    }
    if(!(req.headers['content-type']||'').startsWith('application/json'))fail('JSON required.',415);
  }
  const b=method==='GET'?{}:await body(req);
  // Reads run in parallel; every change waits its turn.
  return method==='GET'?handle(req,res,url,b):exclusive(()=>handle(req,res,url,b));
}

async function handle(req,res,url,b) {
  const route=url.pathname,method=req.method;
  if(route==='/api/tournaments'&&method==='GET'){const u=await requireUser(req);return tournamentService.list(u.id,url.searchParams.get('date')||'today');}
  if(route==='/api/tournament'&&method==='GET'){const u=await requireUser(req);return tournamentService.detail(url.searchParams.get('id'),u.id);}
  if(route==='/api/tournament-book'&&method==='POST'){const u=await requireUser(req);limit(`tour-book:${u.id}`,20);return tournamentService.book(b.id,u);}
  if(route==='/api/tournament-cancel-booking'&&method==='POST'){const u=await requireUser(req);return tournamentService.unbook(b.id,u);}
  if(route==='/api/admin/tournaments'&&method==='GET'){await requireUser(req,true);return tournamentService.adminState();}
  if(route==='/api/admin/tournament-action'&&method==='POST'){const u=await requireUser(req,true);return tournamentService.adminAction(b,u.id);}
  if(route==='/api/config'&&method==='GET'){const s=await settings();return{modes:MODES,stakes:STAKES,settings:{welcome:s.welcome,promo:s.promo,losing:s.losing,lossThreshold:s.lossThreshold,support:s.support,minDeposit:s.minDeposit,minWithdrawal:s.minWithdrawal},bank:{bankName:s.bankName,holderName:s.holderName,accountNumber:s.accountNumber,ifsc:s.ifsc,upi:s.upi,qr:s.qr}};}
  if(route==='/api/me'&&method==='GET'){const u=await session(req);return{user:u?publicUser(u):null};}
  if(route==='/api/login'&&method==='POST') {
    limit(`login:${clientIp(req)}`);const u=await q('SELECT * FROM users WHERE username=?',text(b.username).toLowerCase());
    if(!u||u.blocked||!passwordOK(text(b.password,128),u.password)||(b.admin&&u.role!=='admin')||(!b.admin&&u.role==='admin'))fail('Invalid ID/password or blocked account.',401);
    await loginSession(req,res,u);return{user:publicUser(u)};
  }
  if(route==='/api/logout'&&method==='POST'){const name=cookieFor(areaOf(req));await run('DELETE FROM sessions WHERE token=?',hash(cookie(req,name)||''));setCookie(req,res,name,'',0);return{ok:true};}
  if(route==='/api/password'&&method==='POST') {
    const u=await requireUser(req,false,true);limit(`password:${u.id}`,8);if(!passwordOK(b.current||'',u.password))fail('Current password is incorrect.');validPassword(b.password);
    if(b.password===b.current)fail('Choose a different password.');
    await tx(async()=>{await run('UPDATE users SET password=?,must_change=0 WHERE id=?',passwordHash(b.password),u.id);await run('DELETE FROM sessions WHERE user_id=?',u.id);await audit(u.id,'change_password',{});});
    const updated=await q('SELECT * FROM users WHERE id=?',u.id);await loginSession(req,res,updated);return{user:publicUser(updated)};
  }
  if(route==='/api/signup'&&method==='POST') {
    limit(`signup:${clientIp(req)}`,4);const name=text(b.name,80),mobile=text(b.mobile),username=text(b.username).toLowerCase();
    if(name.length<2||!/^\d{10}$/.test(mobile)||!/^[a-z0-9_]{4,24}$/.test(username))fail('Enter name, a 10-digit mobile and a 4–24 character User ID.');
    if(await q('SELECT 1 FROM users WHERE username=?',username)||await q("SELECT 1 FROM signups WHERE (username=? OR mobile=?) AND status='pending'",username,mobile))fail('An account or pending request already exists.');
    const id=randomUUID(),token=randomBytes(32).toString('hex');await run('INSERT INTO signups(id,token,name,mobile,username,created) VALUES(?,?,?,?,?,?)',id,hash(token),name,mobile,username,now());setCookie(req,res,'pr_signup',token,7*86400);return{id,status:'pending'};
  }
  if(route==='/api/signup-status'&&method==='GET'){const r=await q('SELECT id,status,username FROM signups WHERE token=?',hash(cookie(req,'pr_signup')||''));return{request:r||null};}
  if(route==='/api/signup-delivery'&&method==='POST') {
    return tx(async()=>{const r=await q('SELECT * FROM signups WHERE token=?',hash(cookie(req,'pr_signup')||''));if(!r||r.status!=='approved'||!r.delivery)fail('No unclaimed login details available.',404);const password=decrypt(r.delivery);await run('UPDATE signups SET delivery=NULL WHERE id=?',r.id);return{username:r.username,password};});
  }
  if(route==='/api/tables'&&method==='GET') {
    const u = await requireUser(req);
const disabled = new Set(
  (await all('SELECT id FROM disabled_tables')).map(x => x.id)
);
    return {
  tables: TABLES.map(t => {
    const g = [...games.values()].find(
      x => x.tableId === t.id && x.status !== 'finished'
    );

    return {
      ...t,
      disabled: disabled.has(t.id),
      status: g?.status || 'ready',
      occupancy: g?.players.length || 0,
      gameId: g?.id || null,
      mine: !!g?.players.some(p => p.id === u.id)
    };
  })
};
  }
  if(route==='/api/join'&&method==='POST') {
    const u=await requireUser(req);if(u.role!=='customer')fail('Use a customer account to play.',403);limit(`join:${u.id}`,20);
    const t=tableById(b.tableId);if(!t||await q('SELECT 1 FROM disabled_tables WHERE id=?',t.id))fail('Table unavailable.');
    const previous=[...games.values()].find(
  g=>g.tableId===t.id &&
     g.status!=='finished' &&
     g.players.some(p=>p.id===u.id)
);
if(previous)return{game:viewGame(previous,u.id)};
    if(u.balance<t.stake*100)fail('LOW BALANCE');
    let g=[...games.values()].find(g=>g.tableId===t.id&&g.status!=='finished');
    if(g&&(g.status!=='waiting'||now()>=g.deadline-5000||g.players.length>=g.capacity))fail('Table is in progress. Choose another table.');
    if(!g){g=newGame(t,u);games.set(g.id,g);}else g.players.push({id:u.id,name:u.name,bot:false,score:0,eliminated:false});await saveGame(g);return{game:viewGame(g,u.id)};
  }
  if(route==='/api/game'&&method==='GET') {
    const u=await requireUser(req),g=await findGame(url.searchParams.get('id'));if(!g||!g.players.some(p=>p.id===u.id))fail('Game not found.',404);return{game:viewGame(g,u.id),user:publicUser(u)};
  }
  if(route==='/api/game-action'&&method==='POST') {
    const u=await requireUser(req),g=games.get(b.gameId);if(!g)fail('Game not found.',404);
    const p=g.players.find(p=>p.id===u.id);if(!p)fail('Not your game.',403);
    const actionKey=typeof b.actionId==='string'&&/^[\w-]{8,80}$/.test(b.actionId)?`${u.id}:${b.actionId}`:null;
    if(b.action==='declare'&&!actionKey)fail('A declaration request ID is required.');
    if(actionKey&&g.processedActions?.includes(actionKey))return{game:viewGame(g,u.id),replayed:true};
    if(b.action==='leave'&&g.status==='waiting') {
      g.players=g.players.filter(p=>p.id!==u.id);if(!g.players.some(p=>!p.bot)){g.status='finished';g.cancelled=true;g.settled=true;}await saveGame(g);return{left:true};
    }
    if(g.status!=='playing'||p.dropped||p.eliminated)fail('Wait for the next round.');
    if(b.action==='drop') {
      p.dropScore=g.turns===0?20:40;p.dropped=true;p.drawn=false;
      const active=activePlayers(g);
      if(active.length===1)await roundEnd(g,active[0].id);else if(g.players[g.turn].id===u.id)nextTurn(g);
      await saveGame(g);return{game:viewGame(g,u.id)};
    }
    if(g.players[g.turn].id!==u.id)fail('Wait for your turn.');
    if(b.action==='draw'){if(!['deck','discard'].includes(b.source))fail('Invalid draw source.');gameTry(()=>drawCard(g,p,b.source));}
    else if(b.action==='declare') {
      const result=gameTry(()=>declareHand(g,p,b.cardId));
      g.processedActions=[...(g.processedActions||[]),actionKey];
      if(result.penalty){await saveGame(g);return{game:viewGame(g,u.id),penalty:80,message:'Wrong declaration: +80 points. Continue playing this round.'};}
      await roundEnd(g,p.id);
    }
    else if(b.action==='discard') {
      if(gameTry(()=>discardCard(g,p,b.cardId)))await roundEnd(g,p.id);else nextTurn(g);
    } else fail('Unknown game action.');
    await saveGame(g);return{game:viewGame(g,u.id)};
  }
  if(route==='/api/my-games'&&method==='GET') {
    const u=await requireUser(req);const rows=(await all("SELECT g.state FROM games g WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(g.state::jsonb->'players') AS p WHERE p->>'id'=?) ORDER BY g.created DESC LIMIT 100",u.id)).map(r=>JSON.parse(r.state));
    return{games:rows.map(g=>({id:g.id,tableId:g.tableId,mode:g.mode,stake:g.stake,status:g.status,created:g.created,won:g.winnerId===u.id,tie:!!g.tie,cancelled:!!g.cancelled,round:g.round}))};
  }
  if(route==='/api/wallet'&&method==='GET') {
    const u=await requireUser(req);return{user:publicUser(u),ledger:await all('SELECT * FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 100',u.id),requests:(await all(`SELECT ${REQUEST_COLUMNS} FROM requests r WHERE r.user_id=? ORDER BY r.created DESC LIMIT 50`,u.id)).map(requestView)};
  }
  if(route==='/api/request'&&method==='POST') {
    const u=await requireUser(req);if(u.role!=='customer')fail('Customer account required.',403);limit(`requests:${u.id}`,8);const s=await settings();
    if(!['deposit','withdrawal'].includes(b.kind))fail('Unknown request.');
    const a=amount(b.amount,b.kind==='deposit'?s.minDeposit:s.minWithdrawal);const details={};let proof={bytes:null,mime:null};
    if(b.kind==='deposit') {
      details.utr=text(b.utr,40);details.promo=text(b.promo,30).toUpperCase();
      if(!/^\d{12}$/.test(details.utr))fail('UTR must be exactly 12 digits.');proof=proofInfo(b.proof);if(!proof.bytes)fail('Payment proof image is required.');
      if(await q("SELECT 1 FROM requests WHERE kind='deposit' AND (details::jsonb)->>'utr'=?",details.utr))fail('This UTR number was already submitted. Duplicate UTR is not allowed.');
    } else {
      for(const k of ['holderName','bankName','accountNumber','ifsc'])details[k]=text(b[k],80);
      if(details.holderName.length<2||details.bankName.length<2||!/^\d{9,18}$/.test(details.accountNumber)||! /^[A-Z]{4}0[A-Z0-9]{6}$/.test(details.ifsc))fail('Check your bank details.');
      if(!passwordOK(b.password||'',u.password))fail('Confirm with your login password.');
      if([...games.values()].some(g=>g.status!=='finished'&&g.players.some(p=>p.id===u.id)))fail('Finish or leave your game before withdrawing.');
    }
    const id=randomUUID();await tx(async()=>{if(b.kind==='withdrawal')await credit(u.id,-a,'withdrawal_hold','Withdrawal request held',`${id}:hold`);await run('INSERT INTO requests(id,user_id,kind,amount,details,proof,mime,created) VALUES(?,?,?,?,?,?,?,?)',id,u.id,b.kind,a,JSON.stringify(details),proof.bytes,proof.mime,now());});return{id,status:'pending'};
  }
  if(route==='/api/claim-losing'&&method==='POST') {
    const u=await requireUser(req),s=await settings(),threshold=s.lossThreshold*100;
    await tx(async()=>{const fresh=await q('SELECT * FROM users WHERE id=?',u.id);if(fresh.loss_progress<threshold)fail('Loss threshold has not been reached.');await run('UPDATE users SET loss_progress=loss_progress-? WHERE id=?',threshold,u.id);await credit(u.id,Math.round(threshold*s.losing/100),'losing_bonus','Losing bonus claimed');});return{ok:true};
  }
  if(route.startsWith('/api/proof/')&&method==='GET') {
    // Proof links open in a new tab without the area header, so accept either login here.
    const u=await sessionFor(cookie(req,'pr_admin'),'admin')||await sessionFor(cookie(req,'pr_session'),'customer');if(!u)fail('Please log in.',401);
    const id=route.split('/').at(-1),r=await q('SELECT * FROM requests WHERE id=?',id);
    if(!r||!r.proof||(u.role!=='admin'&&u.id!==r.user_id))fail('Not found.',404);
    res.writeHead(200,{'Content-Type':r.mime,'Content-Disposition':'inline','Cache-Control':'no-store'});res.end(Buffer.from(r.proof));return null;
  }
  if(route.startsWith('/api/admin/')) {
    const admin=await requireUser(req,true);
    if(route==='/api/admin/state'&&method==='GET')return{
      customers:(await all("SELECT * FROM users WHERE role='customer' ORDER BY created DESC")).map(publicUser),
      signups:await all('SELECT id,name,mobile,username,status,created FROM signups ORDER BY created DESC LIMIT 200'),
      requests:(await all(`SELECT ${REQUEST_COLUMNS},u.name,u.username FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.created DESC LIMIT 300`)).map(requestView),
      ledger:await all('SELECT l.*,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created DESC LIMIT 300'),
      audit:await all('SELECT * FROM audit ORDER BY created DESC LIMIT 200'),settings:await settings(),
      activeGames:[...games.values()].map(g=>({id:g.id,tableId:g.tableId,status:g.status,round:g.round,players:g.players.map(p=>({name:p.name,bot:p.bot,score:p.score}))})),disabledTables:(await all('SELECT id FROM disabled_tables')).map(x=>x.id)
    };
    if(route==='/api/admin/create-user'&&method==='POST') {
      const u=await tx(async()=>{const u=await createUser(b);await audit(admin.id,'create_user',{userId:u.id});return u;});return{user:publicUser(u)};
    }
    if(route==='/api/admin/signup'&&method==='POST') {
      return tx(async()=>{const r=await q('SELECT * FROM signups WHERE id=?',b.id);if(!r||r.status!=='pending')fail('Request already handled.');
        if(b.reject){await run("UPDATE signups SET status='rejected' WHERE id=?",r.id);await audit(admin.id,'reject_signup',{id:r.id});return{ok:true};}
        const password=`Pr!${randomBytes(12).toString('base64url')}`;
        const u=await createUser({name:r.name,mobile:r.mobile,username:r.username,password});await run("UPDATE signups SET status='approved',delivery=? WHERE id=?",encrypt(password),r.id);await audit(admin.id,'approve_signup',{id:r.id,userId:u.id});return{ok:true};});
    }
    if(route==='/api/admin/customer'&&method==='POST') {
      const u=await q("SELECT * FROM users WHERE id=? AND role='customer'",b.id);if(!u)fail('Customer not found.',404);
      await tx(async()=>{if(b.action==='block'){await run('UPDATE users SET blocked=? WHERE id=?',b.blocked?1:0,u.id);await run('DELETE FROM sessions WHERE user_id=?',u.id);}
        else if(b.action==='reset'){validPassword(b.password);await run('UPDATE users SET password=?,must_change=1 WHERE id=?',passwordHash(b.password),u.id);await run('DELETE FROM sessions WHERE user_id=?',u.id);}
        else if(b.action==='balance'){
          const delta=amount(b.amount);if(!['add','remove'].includes(b.direction))fail('Choose add/remove.');if(!text(b.note))fail('Enter a reason.');await credit(u.id,b.direction==='remove'?-delta:delta,'admin_adjustment',text(b.note));
        }else fail('Unknown action.');await audit(admin.id,b.action,{userId:u.id,amount:b.amount,direction:b.direction,blocked:b.blocked,note:text(b.note)});
      });return{ok:true};
    }
    if(route==='/api/admin/decide'&&method==='POST') {
      await tx(async()=>{const r=await q('SELECT id,user_id,kind,amount,status FROM requests WHERE id=?',b.id);if(!r||r.status!=='pending')fail('Request already processed.');
        if(!['approve','reject'].includes(b.decision))fail('Choose approve or reject.');
        if(b.decision==='approve'&&r.kind==='deposit')await credit(r.user_id,r.amount,'deposit','Deposit approved',`${r.id}:deposit`);
        if(b.decision==='reject'&&r.kind==='withdrawal')await credit(r.user_id,r.amount,'withdrawal_refund','Rejected withdrawal restored',`${r.id}:restore`);
        await run('UPDATE requests SET status=?,decided=? WHERE id=?',b.decision==='approve'?'approved':'rejected',now(),r.id);await audit(admin.id,'decide_request',{id:r.id,decision:b.decision});
      });return{ok:true};
    }
    if(route==='/api/admin/settings'&&method==='POST') {
      const s=await settings(),clean={};for(const k of Object.keys(DEFAULTS))if(k in b) {
        if(['welcome','promo','losing'].includes(k)){if(typeof b[k]!=='number'||b[k]<0||b[k]>100)fail('Bonus must be 0–100%.');clean[k]=b[k];}
        else if(['lossThreshold','minDeposit','minWithdrawal'].includes(k)){amount(b[k],1);clean[k]=b[k];}
        else if(k==='qr'){if(b[k])proofInfo(b[k]);clean[k]=b[k]||'';}
        else clean[k]=text(b[k],200);
      }
      await tx(async()=>{for(const[k,v]of Object.entries({...s,...clean}))await run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(v),k);await audit(admin.id,'settings',{keys:Object.keys(clean)});});return{ok:true};
    }
    if(route==='/api/admin/table'&&method==='POST') {
      if(!tableById(b.tableId))fail('Invalid table.');if(b.disabled)await run('INSERT INTO disabled_tables(id) VALUES(?) ON CONFLICT DO NOTHING',b.tableId);else await run('DELETE FROM disabled_tables WHERE id=?',b.tableId);await audit(admin.id,'table_toggle',{tableId:b.tableId,disabled:!!b.disabled});return{ok:true};
    }
    if(route==='/api/admin/cancel-game'&&method==='POST'){const g=games.get(b.gameId);if(!g)fail('Game not found.');if(g.status==='waiting'){g.status='finished';g.settled=true;g.cancelled=true;await saveGame(g);}else await cancel(g,'Cancelled by admin; stakes refunded.');await audit(admin.id,'cancel_game',{gameId:g.id});return{ok:true};}
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
function shutdown(){clearInterval(ticker);server.close(async()=>{try{await closeDatabase();}catch{}process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e));
