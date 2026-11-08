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
