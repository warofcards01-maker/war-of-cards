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
export function rankEntries(entries,prizes){
  const sorted=[...entries].sort((a,b)=>a.score-b.score||a.id.localeCompare(b.id)),out=[];
  for(let i=0;i<sorted.length;){let end=i+1;while(end<sorted.length&&sorted[end].score===sorted[i].score)end++;
    const pool=Array.from({length:end-i},(_,k)=>(prizes[i+k]||0)*100).reduce((a,b)=>a+b,0),base=Math.floor(pool/(end-i)),rem=pool%(end-i);
    for(let j=i;j<end;j++)out.push({...sorted[j],rank:i+1,prize:base+(j-i<rem?1:0)});i=end;
  }return out;
}
export async function createTournamentService({db,credit,tx,audit,games,saveGame,clock=Date.now}){
  const {q,all,run}=db;
  const error=(m,status=400)=>{const e=Error(m);e.status=status;throw e;};
  const config=e=>JSON.parse(e.config);
  const entries=id=>all("SELECT * FROM tour_entries WHERE event_id=$1 AND status!='cancelled'",id);
  for(const c of DEFAULT_TOURNAMENTS)await run('INSERT INTO tour_templates(id,config) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',c.id,JSON.stringify(c));
  async function fund(amount,kind,note,ref){
    if(await q('SELECT 1 FROM tour_fund_ledger WHERE ref=$1',ref))return;
    const b=(await q('SELECT balance FROM tour_fund WHERE id=1')).balance;
    if(!Number.isSafeInteger(amount)||b+amount<0)error('Insufficient tournament prize reserve.');
    await run('UPDATE tour_fund SET balance=balance+$1 WHERE id=1',amount);
    await run('INSERT INTO tour_fund_ledger(id,amount,kind,note,ref,created) VALUES($1,$2,$3,$4,$5,$6)',randomUUID(),amount,kind,note,ref,clock());
  }
  let ensuredDay=null;
  async function ensureSchedule(){
    const day=localDay(clock());if(ensuredDay===day)return;
    const templates=await all('SELECT * FROM tour_templates');
    for(const d of [day,day+1])for(const h of HOURS)for(const r of templates){
      const id=`${dayName(d)}-${h}-${r.id}`,start=slotStart(d,h);
      await run("INSERT INTO tour_events(id,template_id,start,closes,opens,status,config,created) VALUES($1,$2,$3,$4,$5,'scheduled',$6,$7) ON CONFLICT(id) DO NOTHING",id,r.id,start,start-600000,slotStart(d-1,0),r.config,clock());
    }
    ensuredDay=day;
  }
  async function stats(events,userId){
    const ids=events.map(e=>e.id),counts=new Map(),mine=new Map();
    if(!ids.length)return{counts,mine};
    for(const r of await all("SELECT event_id,COUNT(*) AS joined,SUM(CASE WHEN bot=0 THEN 1 ELSE 0 END) AS humans FROM tour_entries WHERE event_id=ANY($1) AND status!='cancelled' GROUP BY event_id",ids))counts.set(r.event_id,{joined:Number(r.joined),humans:Number(r.humans||0)});
    if(userId)for(const r of await all("SELECT * FROM tour_entries WHERE event_id=ANY($1) AND user_id=$2 AND bot=0 AND status!='cancelled'",ids,userId))mine.set(r.event_id,r);
    return{counts,mine};
  }
  function view(e,s,userId){
    const c=config(e),cnt=s.counts.get(e.id)||{joined:0,humans:0},mine=s.mine.get(e.id);
    const active=mine?[...games.values()].find(g=>g.tournamentId===e.id&&g.status!=='finished'&&g.players.some(p=>p.id===userId)):null;
    return {...c,id:e.id,templateId:c.id,start:e.start,closes:e.closes,opens:e.opens,status:e.status,round:e.round,reserve:e.reserve,reason:e.reason,totalPrize:c.prizes.reduce((a,b)=>a+b,0),joined:cnt.joined,humanCount:cnt.humans,computerCount:cnt.joined-cnt.humans,mine:mine?{entryId:mine.id,score:mine.score,played:mine.played,rank:mine.rank,prize:mine.prize,gameId:active?.id}:null};
  }
  async function list(userId,date='today'){
    await ensureSchedule();
    const day=localDay(clock())+(date==='tomorrow'?1:0),start=slotStart(day,0),end=start+DAY;
    const events=await all('SELECT * FROM tour_events WHERE start>=$1 AND start<$2 ORDER BY start,template_id',start,end),s=await stats(events,userId);
    return {serverNow:clock(),timeZone:'Asia/Kolkata',hours:HOURS,date:dayName(day),events:events.map(e=>view(e,s,userId))};
  }
  async function detail(id,userId){
    const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e)error('Tournament not found.',404);
    const s=await stats([e],userId),rows=await entries(id);
    return{event:view(e,s,userId),leaderboard:rows.sort((a,b)=>(a.rank||99999)-(b.rank||99999)||a.score-b.score||a.id.localeCompare(b.id)).slice(0,1000).map(x=>({name:x.name,bot:!!x.bot,score:x.score,played:x.played,rank:x.rank,prize:x.prize,mine:x.user_id===userId})),matches:await all('SELECT round,number,status FROM tour_matches WHERE event_id=$1 ORDER BY round,number',id)};
  }
  async function book(id,user){
    await ensureSchedule();
    return tx(async()=>{
      const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e)error('Tournament not found.',404);
      if(user.role!=='customer')error('Customer account required.',403);
      if(clock()<e.opens||clock()>=e.closes||e.status!=='open')error('Registration is closed or prizes have not been funded.');
      const existing=await q("SELECT * FROM tour_entries WHERE event_id=$1 AND user_id=$2 AND status!='cancelled'",id,user.id);if(existing)return{entryId:existing.id,alreadyBooked:true};
      if(await q("SELECT 1 FROM tour_entries p JOIN tour_events e ON e.id=p.event_id WHERE p.user_id=$1 AND p.bot=0 AND p.status!='cancelled' AND e.start=$2 AND e.status IN ('open','locked','running')",user.id,e.start))error('You already booked another tournament at this time.');
      const c=config(e);if((await entries(id)).length>=c.capacity)error('Tournament is full.');
      const entryId=randomUUID();await credit(user.id,-c.fee*100,'tournament_entry',`${c.name} · ${id}`,`${entryId}:entry`);
      await run("INSERT INTO tour_entries(id,event_id,user_id,name,bot,status,created) VALUES($1,$2,$3,$4,0,'registered',$5)",entryId,id,user.id,user.name,clock());
      return{entryId};
    });
  }
  function unbook(id,user){
    return tx(async()=>{
      const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e||clock()>=e.closes||e.status!=='open')error('Booking cancellation closes ten minutes before start.');
      const p=await q("SELECT * FROM tour_entries WHERE event_id=$1 AND user_id=$2 AND bot=0 AND status='registered'",id,user.id);if(!p)error('No active booking.');
      await credit(user.id,config(e).fee*100,'tournament_refund','Tournament booking cancelled',`${p.id}:refund`);
      await run("UPDATE tour_entries SET status='cancelled' WHERE id=$1",p.id);return{ok:true};
    });
  }
  async function cancel(id,reason='Cancelled by admin'){
    const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e||['finished','cancelled'].includes(e.status))return;
    const active=await all("SELECT id FROM tour_matches WHERE event_id=$1 AND status='playing'",id);
    await tx(async()=>{
      const fresh=await q('SELECT * FROM tour_events WHERE id=$1',id);if(['finished','cancelled'].includes(fresh.status))return;
      for(const p of (await entries(id)).filter(p=>!p.bot))await credit(p.user_id,config(fresh).fee*100,'tournament_refund',reason,`${p.id}:refund`);
      if(fresh.reserve)await fund(fresh.reserve,'reserve_return',reason,`${id}:cancel-reserve`);
      await run("UPDATE tour_entries SET status='cancelled' WHERE event_id=$1",id);
      await run("UPDATE tour_events SET status='cancelled',reserve=0,reason=$1 WHERE id=$2",reason,id);
      for(const m of active){
        let g=games.get(m.id);
        if(!g){const row=await q('SELECT state FROM games WHERE id=$1',m.id);if(row)g=JSON.parse(row.state);}
        if(g){g.status='finished';g.cancelled=true;g.settled=true;g.tournamentCancelled=true;g.log.push(reason);await saveGame(g);}
      }
      await run("UPDATE tour_matches SET status='cancelled' WHERE event_id=$1 AND status='playing'",id);
    });
    for(const m of active)games.delete(m.id);
  }
  async function lock(id){
    const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e||!['open','scheduled'].includes(e.status))return;
    const humans=(await entries(id)).filter(p=>!p.bot);
    if(!humans.length){await cancel(id,'No human registrations');return;}
    if(!e.reserve){await cancel(id,'Prize pool was not funded');return;}
    await tx(async()=>{
      const c=config(e),list=await entries(id),used=new Set(list.map(x=>x.name)),names=shuffle(BOT_NAMES).filter(n=>!used.has(n)),rows=[];
      for(let i=list.length;i<c.capacity;i++)rows.push([randomUUID(),id,`bot-${randomUUID()}`,names[i-list.length]||`Computer ${i+1}`,clock()]);
      for(let i=0;i<rows.length;i+=200){
        const part=rows.slice(i,i+200);
        const placeholders=part.map((_,idx)=>`($${idx*5+1},$${idx*5+2},$${idx*5+3},$${idx*5+4},1,'registered',$${idx*5+5})`).join(',');
        await run(`INSERT INTO tour_entries(id,event_id,user_id,name,bot,status,created) VALUES ${placeholders}`,...part.flat());
      }
      await run("UPDATE tour_events SET status='locked' WHERE id=$1",id);
    });
  }
  async function launchRound(id){
    const e=await q('SELECT * FROM tour_events WHERE id=$1',id),c=config(e),round=e.round+1,players=shuffle(await entries(id)),pending=[];
    await tx(async()=>{
      const fresh=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!['locked','running'].includes(fresh.status)||fresh.round!==e.round)return;
      if(await q("SELECT 1 FROM tour_matches WHERE event_id=$1 AND status='playing'",id))return;
      const tables=Math.ceil(players.length/6),base=Math.floor(players.length/tables),extra=players.length%tables;let offset=0;
      for(let i=0;i<tables;i++){
        const count=base+(i<extra?1:0),seats=players.slice(offset,offset+count);offset+=count;
        const g={id:randomUUID(),tableId:`TOUR-${id}-R${round}-T${i+1}`,mode:'deals',stake:c.fee,capacity:count,label:`T${i+1}`,status:'waiting',created:clock(),deadline:clock(),round:0,turns:0,tournamentId:id,tournamentName:c.name,tournamentRound:round,tournamentRounds:c.rounds,hardDeadline:clock()+c.roundMinutes*60000,log:[`${c.name}: round ${round}/${c.rounds}. Lowest total points ranks first.`],players:seats.map(p=>({id:p.user_id,name:p.name,bot:!!p.bot,score:0,eliminated:false,entryId:p.id}))};
        startRound(g,clock());await saveGame(g);
        await run("INSERT INTO tour_matches(id,event_id,round,number,status) VALUES($1,$2,$3,$4,'playing')",g.id,id,round,i+1);pending.push(g);
      }
      await run("UPDATE tour_events SET status='running',round=$1 WHERE id=$2",round,id);
    });
    for(const g of pending)games.set(g.id,g);
  }
  async function finishEvent(id){
    const e=await q('SELECT * FROM tour_events WHERE id=$1',id);if(!e||e.status!=='running')return;
    const c=config(e),ranked=rankEntries(await entries(id),c.prizes);
    await tx(async()=>{
      const fresh=await q('SELECT * FROM tour_events WHERE id=$1',id);if(fresh.status!=='running')return;
      let paid=0;
      for(const p of ranked){
        await run('UPDATE tour_entries SET rank=$1,prize=$2 WHERE id=$3',p.rank,p.prize,p.id);
        if(!p.bot&&p.prize){await credit(p.user_id,p.prize,'tournament_prize',`${c.name}: rank ${p.rank}`,`${id}:prize:${p.id}`);paid+=p.prize;}
      }
      const humans=ranked.filter(p=>!p.bot),fees=humans.length*c.fee*100;
      if(paid>fresh.reserve)error('Prize reserve mismatch.');
      await fund(fresh.reserve-paid+fees,'tournament_settlement',`${c.name}: ${humans.length} human entries; computer awards remain in reserve`,`${id}:settlement`);
      for(const p of humans)await run('UPDATE users SET loss_progress=GREATEST(0,loss_progress+$1) WHERE id=$2',c.fee*100-p.prize,p.user_id);
      await run("UPDATE tour_entries SET status='finished' WHERE event_id=$1 AND status!='cancelled'",id);
      await run("UPDATE tour_events SET status='finished',reserve=0 WHERE id=$1",id);
      await audit('system','tournament_finished',{id,paid,humanEntries:humans.length});
    });
  }
  async function recordMatch(g){
    if(g.status!=='finished')error('Match is not finished.');
    const row=await q('SELECT * FROM tour_matches WHERE id=$1',g.id);if(!row||row.status!=='playing')return;
    await tx(async()=>{
      const fresh=await q('SELECT status FROM tour_matches WHERE id=$1',g.id);if(fresh.status!=='playing')return;
      for(const p of g.players)await run('UPDATE tour_entries SET score=score+$1,played=played+1 WHERE id=$2',p.score,p.entryId);
      g.settled=true;await saveGame(g);
      await run("UPDATE tour_matches SET status='finished' WHERE id=$1",g.id);
    });
  }
  async function expireMatch(g){
    if(g.status!=='playing')return;
    for(const p of g.players){const hand=p.drawn?p.hand.slice(0,13):p.hand;p.roundScore=p.dropped?(p.dropScore||40):analyze(hand,g.wild).score;p.score+=p.roundScore;}
    g.status='finished';g.winnerId=null;g.log.push('Timed round completed. Remaining cards scored.');
    await recordMatch(g);await saveGame(g);
  }
  let lastEnsure=0;
  async function tick(){
    const t=clock();if(t-lastEnsure>60000){await ensureSchedule();lastEnsure=t;}
    for(const e of await all("SELECT * FROM tour_events WHERE status IN ('scheduled','open','locked','running') AND closes<=$1",t)){
      try{
        if(['scheduled','open'].includes(e.status))await lock(e.id);
        const fresh=await q('SELECT * FROM tour_events WHERE id=$1',e.id);
        if(fresh.status==='locked'&&t>fresh.start+120000)await cancel(e.id,'Server missed the start time; entries refunded');
        else if(fresh.status==='locked'&&t>=fresh.start)await launchRound(e.id);
        else if(fresh.status==='running'&&!(await q("SELECT 1 FROM tour_matches WHERE event_id=$1 AND status='playing'",e.id))){
          if(fresh.round>=config(fresh).rounds)await finishEvent(e.id);else await launchRound(e.id);
        }
      }catch(err){
        console.error('Tournament recovery',e.id,err.message);
        try{await cancel(e.id,'Tournament interrupted; entries refunded');}catch(err2){console.error('Tournament cancel failed',e.id,err2.message);}
      }
    }
  }
  async function adminState(){
    await ensureSchedule();
    const day=slotStart(localDay(clock()),0),events=await all('SELECT * FROM tour_events WHERE start>=$1 ORDER BY start,template_id',day),s=await stats(events);
    return{fund:(await q('SELECT balance FROM tour_fund WHERE id=1')).balance,templates:(await all('SELECT config FROM tour_templates')).map(x=>JSON.parse(x.config)),events:events.map(e=>view(e,s)),ledger:await all('SELECT * FROM tour_fund_ledger ORDER BY created DESC LIMIT 100')};
  }
  async function adminAction(b,actor){
    if(b.action==='fund-adjust'){
      if(!Number.isSafeInteger(b.amount)||b.amount===0||Math.abs(b.amount)>100000000000)error('Enter a non-zero amount in paise.');
      if(typeof b.note!=='string'||b.note.trim().length<3)error('Enter a reason.');
      await tx(async()=>{await fund(b.amount,'admin_adjustment',b.note.slice(0,200),randomUUID());await audit(actor,'tournament_fund',{amount:b.amount,note:b.note});});
    }
    else if(b.action==='open'){
      await ensureSchedule();
      await tx(async()=>{
        const e=await q('SELECT * FROM tour_events WHERE id=$1',b.id);if(!e||e.status!=='scheduled'||clock()>=e.closes)error('This event cannot be opened.');
        const total=config(e).prizes.reduce((a,b)=>a+b,0)*100;
        await fund(-total,'prize_reserve',e.id,`${e.id}:reserve`);
        await run("UPDATE tour_events SET status='open',reserve=$1 WHERE id=$2",total,e.id);
        await audit(actor,'tournament_open',{id:e.id,total});
      });
    }
    else if(b.action==='cancel'){await cancel(b.id,'Cancelled by admin');await audit(actor,'tournament_cancel',{id:b.id});}
    else if(b.action==='template'){
      let c;try{c=validateTemplate(b.template);}catch(e){error(e.message);}
      await tx(async()=>{
        await run('UPDATE tour_templates SET config=$1 WHERE id=$2',JSON.stringify(c),c.id);
        for(const e of await all("SELECT * FROM tour_events WHERE template_id=$1 AND status='scheduled'",c.id))await run('UPDATE tour_events SET config=$1 WHERE id=$2',JSON.stringify(c),e.id);
        await audit(actor,'tournament_template',{id:c.id});
      });
    }
    else error('Unknown tournament action.');
    return{ok:true};
  }
  await ensureSchedule();
  return{list,detail,book,unbook,cancel,tick,recordMatch,expireMatch,adminState,adminAction};
}
