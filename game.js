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
