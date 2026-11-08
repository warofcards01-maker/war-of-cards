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
