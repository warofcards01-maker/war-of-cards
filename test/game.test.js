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
