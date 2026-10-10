const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs'), path = require('path');
const stats = require('./statistics');
const {TournamentDatabase}=require('./database');
const app = express(), server = http.createServer(app), io = new Server(server, { maxHttpBufferSize: 6e6 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.redirect('/control.html'));
app.get('/api/connection',(_,res)=>{
 const interfaces=Object.values(require('os').networkInterfaces()).flat();
 res.json({urls:interfaces.filter(n=>n&&n.family==='IPv4'&&!n.internal&&!n.address.startsWith('169.254.')).map(n=>`http://${n.address}:${process.env.PORT||3000}/control.html`)});
});
const file = process.env.SCOREBOARD_DATA_FILE || path.join(__dirname, 'scoreboard-data.json');
const tournamentDb=new TournamentDatabase(process.env.SCOREBOARD_DB_FILE||path.join(path.dirname(file),'scoreboard.sqlite'));
server.on('close',()=>tournamentDb.close());
const seed = {
 away: { teamName: '狂龍', color: '#67e8b5', logo: '', lineup: [{no:'24',name:'陳傑憲',pos:'LF'},{no:'39',name:'林立',pos:'RF'},{no:'99',name:'林安可',pos:'DH'}] },
 home: { teamName: '悍將', color: '#ffb86b', logo: '', lineup: [{no:'9',name:'王威晨',pos:'P'},{no:'90',name:'江坤宇',pos:'C'},{no:'88',name:'詹子賢',pos:'LF'}] }
};
const positions = ['DH','C','RF','LF','P'];
const defaultRules = {innings:7,extraInnings:true,maxExtraInnings:0};
const fresh = (rosters,rules=defaultRules) => ({ inning:1, half:'top', score:{away:0,home:0}, outs:0,strikes:0,balls:0,bases:[0,0,0],pitchCount:{away:0,home:0},rosters,currentBatterIndex:{away:0,home:0},ended:false,log:[],retired:{away:[],home:[]},rules:{...rules} });
let state = fresh(seed), undo = [];
try { if(fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file,'utf8')); } catch(e) { console.error('讀取存檔失敗',e.message); }
const savedMatch=tournamentDb.active();
if(savedMatch)state=savedMatch;
else if(fs.existsSync(file)&&!fs.existsSync(file+'.before-sqlite'))fs.copyFileSync(file,file+'.before-sqlite');
state.rules = {...defaultRules,...state.rules};
const attack = () => state.half === 'top' ? 'away' : 'home';
const defense = () => state.half === 'top' ? 'home' : 'away';
const clone = value => JSON.parse(JSON.stringify(value));
function outgoing(){return {...state,summary:resultSummary(),competition:tournamentDb.view(state),tournaments:tournamentDb.list(),canUndo:undo.length>0};}
function publish(){stats.ensure(state);tournamentDb.save(state);try { fs.writeFileSync(file,JSON.stringify(state,null,2)); } catch(e){ console.error(e); } io.emit('update_gamestate',outgoing()); }
app.get('/api/database-backup',(_,res)=>{const backup=path.join(path.dirname(file),'scoreboard-backup.sqlite');try{tournamentDb.backup(backup);res.download(backup,'TCBA-scoreboard-backup.sqlite');}catch(e){res.status(500).json({error:'資料庫備份失敗'});}});
app.get('/api/tournament-export',(_,res)=>{const id=state.tournament.id;res.attachment('TCBA-tournament-records.json').json({tournament:state.tournament,players:tournamentDb.totals(id,state.matchId),matches:tournamentDb.db.prepare('SELECT state_json FROM matches WHERE tournament_id=? ORDER BY created_at').all(id).map(row=>JSON.parse(row.state_json))});});
function reset(){ state.balls=0;state.strikes=0; }
function effect(type,text,extra={}){ io.emit('show_effect',{type,text,...extra}); }
function record(result){ stats.appearance(state,defense(),result);const team=attack(), player=state.rosters[team].lineup[state.currentBatterIndex[team]]; (player.results ||= []).push(result); state.log.unshift({text:`${state.rosters[team].teamName} · ${player.name} · ${result}`,time:new Date().toISOString()}); state.currentBatterIndex[team]=(state.currentBatterIndex[team]+1)%state.rosters[team].lineup.length; reset(); }
function finish(reason='manual'){
 state.ended=true;state.endReason=reason;
 const winner=state.score.away===state.score.home?null:state.score.away>state.score.home?'away':'home';
 effect('victory',winner?`${state.rosters[winner].teamName}'s win`:'DRAW',winner?state.rosters[winner]:{});
}
function change(){
 const atLimit=state.inning>=state.rules.innings;
 if(atLimit&&state.half==='top'&&state.score.home>state.score.away){finish('home-leading');return;}
 if(atLimit&&state.half==='bottom'){
  if(state.score.home!==state.score.away){finish('regulation');return;}
  if(!state.rules.extraInnings||(state.rules.maxExtraInnings>0&&state.inning>=state.rules.innings+state.rules.maxExtraInnings)){finish('tie-limit');return;}
 }
 state.outs=0;reset();state.bases=[0,0,0];stats.ensure(state).runners=[null,null,null];if(state.half==='top')state.half='bottom';else{state.half='top';state.inning++;}
 effect('change',state.inning>state.rules.innings?'EXTRA INNINGS':'CHANGE SIDES');
}
function out(result){record(result);state.outs++;const events={K:['strikeout','STRIKE OUT'],GO:['groundout','GROUND OUT'],FO:['flyout','FLY OUT']};if(events[result])effect(...events[result]);if(state.outs===3)change();}
function resultSummary(){
 const winner=state.score.away===state.score.home?null:state.score.away>state.score.home?'away':'home';
 const all=Object.fromEntries(['away','home'].map(team=>[team,[...state.rosters[team].lineup,...(state.retired?.[team]||[])]]));
 return {...stats.summary(state),homeruns:['away','home'].flatMap(team=>all[team].map(p=>({team,teamName:state.rosters[team].teamName,name:p.name,no:p.no,id:p.id,count:(p.results||[]).filter(r=>r==='HR').length})).filter(p=>p.count))};
}
function hit(n,result){
 const team=attack(),other=defense(),before=state.score[team],wasBehind=before<state.score[other];
 const t=stats.ensure(state),batter=state.rosters[team].lineup[state.currentBatterIndex[team]],newRunner=stats.batterRunner(state,team),scored=[];
 const runners=state.bases.map((occupied,i)=>occupied?(t.runners[i]||{player:null,pitcher:null}):null);
 if(result==='BB'){const [a,b,c]=runners;if(a&&b&&c)scored.push(c);t.runners=[newRunner,a||b,a&&b?b:c];}
 else{const next=[null,null,null];[newRunner,...runners].forEach((r,i)=>{if(r){if(i+n>=4)scored.push(r);else next[i+n-1]=r;}});t.runners=next;scored.reverse();state.pitchCount[other]++;stats.pitch(state,other);}
 if(result!=='HR'&&team==='home'&&state.inning>=state.rules.innings&&before<=state.score.away)scored.splice(Math.max(0,state.score.away-before+1));
 stats.scoring(state,team,scored,batter,result);state.bases=t.runners.map(r=>r?1:0);
 const runs=state.score[team]-before,reversal=wasBehind&&state.score[team]>state.score[other];
 const walkoff=team==='home'&&state.inning>=state.rules.innings&&runs>0&&before<=state.score.away&&state.score.home>state.score.away;
 if(walkoff&&result!=='HR')state.score.home=state.score.away+1;
 record(result);
 const text=result==='HR'?(runs===4?'GRAND SLAM':`${runs} RUN HOMER`):result==='BB'?'BALL FOUR':`${n} BASE HIT`;
 effect(result==='HR'?'homerun':'hit',text,{runs,reversal,walkoff,subtitle:walkoff?(reversal?'逆轉再見 · WALK-OFF':'再見 · WALK-OFF'):reversal?'逆轉 · COMEBACK':'',teamName:state.rosters[team].teamName});
 if(walkoff)finish('walkoff');
}
function cleanRules(r){if(!r||!Number.isInteger(r.innings)||r.innings<1||r.innings>30||typeof r.extraInnings!=='boolean'||!Number.isInteger(r.maxExtraInnings)||r.maxExtraInnings<0||r.maxExtraInnings>30)throw Error('正規局數需為 1–30，延長上限需為 0–30（0 為不限）');return {innings:r.innings,extraInnings:r.extraInnings,maxExtraInnings:r.maxExtraInnings};}
function cleanRosters(input){const output={};for(const key of ['away','home']){const t=input?.[key];if(!t||typeof t.teamName!=='string'||!t.teamName.trim()||!Array.isArray(t.lineup)||!t.lineup.length||t.lineup.length>40)throw Error('兩隊都需要隊名及 1–40 位球員');const numbers=new Set();output[key]={teamName:t.teamName.trim().slice(0,40),color:/^#[0-9a-f]{6}$/i.test(t.color)?t.color:seed[key].color,logo:typeof t.logo==='string'&&(/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(t.logo))&&t.logo.length<2800000?t.logo:'',lineup:t.lineup.map(p=>{const no=String(p.no??'').trim(),name=String(p.name??'').trim();if(!name||!/^\d{1,3}$/.test(no)||numbers.has(no))throw Error('球員需填姓名及不重複的 0–999 背號');numbers.add(no);if(!positions.includes(p.pos))throw Error('請選擇有效守位');return {id:typeof p.id==='string'?p.id:require('crypto').randomUUID(),no,name:name.slice(0,40),pos:p.pos};})};}return output;}
state.rosters = Object.fromEntries(Object.entries(state.rosters).map(([k,t])=>[k,{...t,lineup:t.lineup.map(p=>({...p,id:p.id||require('crypto').randomUUID(),pos:positions.includes(p.pos)?p.pos:'DH'}))}]));
stats.ensure(state);
tournamentDb.save(state);
io.on('connection',socket=>{
 socket.emit('update_gamestate',outgoing());
 socket.on('command',(data,ack=()=>{})=>{const previous=clone(state);try{
  if(!data||typeof data.type!=='string')throw Error('無效操作');
  if(data.type==='undo'){if(!undo.length)throw Error('沒有可復原的操作');const restore=undo[undo.length-1];state=restore;publish();undo.pop();io.emit('update_gamestate',outgoing());return ack({ok:true});}
  if(state.ended&&!['new_game','rosters','tournament','import_game','resume_game'].includes(data.type))throw Error('比賽已結束，請建立新比賽');
  switch(data.type){
   case 'pitch': if(!['ball','strike','foul'].includes(data.value))throw Error('無效球種');stats.pitch(state,defense());state.pitchCount[defense()]++;if(data.value==='ball'){if(++state.balls===4)hit(1,'BB');}else if(data.value==='strike'){if(++state.strikes===3)out('K');}else if(state.strikes<2)state.strikes++;break;
   case 'hit': if(!['1B','2B','3B','HR','BB'].includes(data.value))throw Error('無效結果');hit({ '1B':1,'2B':2,'3B':3,HR:4,BB:1 }[data.value],data.value);break;
   case 'out': if(!['K','OUT','GO','FO'].includes(data.value))throw Error('無效出局');stats.pitch(state,defense());state.pitchCount[defense()]++;out(data.value);break;

   case 'pitcher':if(!['away','home'].includes(data.team))throw Error('無效球隊');stats.changePitcher(state,data.team,data.value);break;
   case 'change':change();break;
   case 'base':if(![0,1,2].includes(data.value))throw Error('無效壘包');state.bases[data.value]=1-state.bases[data.value];stats.ensure(state).runners[data.value]=state.bases[data.value]?{player:null,pitcher:stats.batterRunner(state,attack()).pitcher}:null;break;
   case 'score':if(!['away','home'].includes(data.team)||![1,-1].includes(data.value))throw Error('無效比分');if(data.value===1)stats.scoring(state,data.team,[{player:null,pitcher:null}],null,'MANUAL');else{state.score[data.team]=Math.max(0,state.score[data.team]-1);stats.ensure(state).lead=null;stats.ensure(state).complete=false;}break;
   case 'batter':if(!Number.isInteger(data.value)||!state.rosters[attack()].lineup[data.value])throw Error('無效棒次');state.currentBatterIndex[attack()]=data.value;reset();break;
   case 'rosters':{const rosters=cleanRosters(data.value);for(const key of ['away','home']){const old=state.rosters[key].lineup;state.retired ||= {away:[],home:[]};state.retired[key].push(...old.filter(p=>p.results?.length&&!rosters[key].lineup.some(n=>n.id===p.id)));rosters[key].lineup.forEach(p=>{p.results=old.find(o=>o.id===p.id)?.results||[];});const idx=rosters[key].lineup.findIndex(p=>p.id===old[state.currentBatterIndex[key]]?.id);state.currentBatterIndex[key]=Math.max(0,idx);}state.rosters=rosters;const tracking=stats.ensure(state);for(const team of ['away','home']){if(!rosters[team].lineup.some(p=>p.id===tracking.pitchers[team]?.id))tracking.pitchers[team]=rosters[team].lineup.find(p=>p.pos==='P')||null;}break;}
   case 'rules':state.rules=cleanRules(data.value);break;
   case 'new_game':{const tournament=state.tournament;state=fresh(cleanRosters(data.value||state.rosters),state.rules);state.tournament=tournament;break;}
   case 'tournament':{const tournament=data.name?tournamentDb.create(data.name):tournamentDb.tournament(data.value);state=fresh(cleanRosters(state.rosters),state.rules);state.tournament=tournament;break;}
   case 'resume_game':state=tournamentDb.match(data.value,state.tournament.id);break;
   case 'import_game':{
    const incoming=clone(data.value);if(!incoming||!incoming.ended||!incoming.score||!['away','home'].every(team=>Number.isInteger(incoming.score[team])&&incoming.score[team]>=0))throw Error('請匯入已結束比賽的完整 JSON 紀錄');
    incoming.matchId ||= require('crypto').createHash('sha256').update(state.tournament.id+JSON.stringify(data.value)).digest('hex');
    for(const team of ['away','home']){const t=incoming.rosters?.[team];if(!t||!Array.isArray(t.lineup)||!t.lineup.length||t.lineup.length>40)throw Error('匯入名單不正確');for(const p of [...t.lineup,...(incoming.retired?.[team]||[])]){if(typeof p.name!=='string'||!/^\d{1,3}$/.test(String(p.no))||!Array.isArray(p.results||[]))throw Error('球員紀錄不正確');if((p.results||[]).some(r=>!['1B','2B','3B','HR','BB','K','GO','FO','OUT','H'].includes(r)))throw Error('含不支援的打席結果');p.id ||= require('crypto').randomUUID();}}
    incoming.tournament=state.tournament;incoming.log ||= [];incoming.retired ||= {away:[],home:[]};incoming.currentBatterIndex ||= {away:0,home:0};stats.ensure(incoming);tournamentDb.importMatch(incoming);break;
   }
   case 'finish':finish();break;
   default:throw Error('未知操作');
  }
  undo.push(previous);if(undo.length>100)undo.shift();publish();ack({ok:true});
 }catch(e){state=previous;ack({ok:false,error:e.message});}});
});
if(require.main===module){
 const port=process.env.PORT||3000;
 server.on('error',error=>{
  if(error.code==='EADDRINUSE'){
   console.log(`連接埠 ${port} 已有服務運作，請勿重複啟動。`);
   console.log(`若是記分板已在背景啟動，可直接開啟 http://localhost:${port}/control.html`);
   console.log('若需更新程式，請先停止原本的記分板服務，再重新啟動。');
  }else{console.error('記分板啟動失敗：',error.message);}
  process.exitCode=1;
 });
 server.listen(port,'0.0.0.0',()=>console.log(`控制台 http://localhost:${port}/control.html · 大螢幕 http://localhost:${port}/display.html`));
}
module.exports={server,cleanRosters,resultSummary};
