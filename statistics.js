// Pitchers and baserunners are snapshots so substitutions cannot rewrite past plays.
const copy=p=>p?{id:p.id,name:p.name,no:p.no}:null;
function ensure(s){
 if(!s.tracking)s.tracking={complete:s.log.length===0&&s.score.away===0&&s.score.home===0,pitchers:{away:null,home:null},runners:[null,null,null],lead:null,events:[]};
 for(const team of ['away','home'])if(!s.tracking.pitchers[team])s.tracking.pitchers[team]=copy(s.rosters[team].lineup.find(p=>p.pos==='P'));
 if(!s.tracking.pitchStats){s.tracking.pitchStats={};for(const team of ['away','home']){const p=s.tracking.pitchers[team];if(p)s.tracking.pitchStats[`${team}:${p.id}`]={pitches:0,k:0,bb:0,complete:!(s.pitchCount?.[team]>0)};}}
 return s.tracking;
}
function pitcherEntry(s,team){const t=ensure(s),p=t.pitchers[team];if(!p)return null;return t.pitchStats[`${team}:${p.id}`] ||= {pitches:0,k:0,bb:0,complete:true};}
function pitch(s,team){const entry=pitcherEntry(s,team);if(entry)entry.pitches++;}
function appearance(s,team,result){const entry=pitcherEntry(s,team);if(entry){if(result==='K')entry.k++;if(result==='BB')entry.bb++;}}
function currentPitcher(s,team){const t=ensure(s),p=t.pitchers[team],entry=pitcherEntry(s,team);return p?{...copy(p),...entry,team,teamName:s.rosters[team].teamName}:null;}
function changePitcher(s,team,id){const p=[...s.rosters[team].lineup,...(s.retired?.[team]||[])].find(p=>p.id===id);if(!p)throw Error('請選擇有效投手');ensure(s).pitchers[team]=copy(p);}
function batterRunner(s,team){return {player:copy(s.rosters[team].lineup[s.currentBatterIndex[team]]),pitcher:copy(ensure(s).pitchers[team==='away'?'home':'away'])};}
function scoring(s,team,runners,batter,result){
 const t=ensure(s),other=team==='away'?'home':'away';
 for(const runner of runners){s.score[team]++;const event={team,inning:s.inning,half:s.half,result,batter:copy(batter),runner:runner?.player||null,responsiblePitcher:runner?.pitcher||null,winningPitcher:copy(t.pitchers[team]),score:{...s.score}};t.events.push(event);
 if(s.score[team]===s.score[other])t.lead=null;
 else if(s.score[team]===s.score[other]+1)t.lead=event;
 }
}
function summary(s){const t=ensure(s),winner=s.score.away===s.score.home?null:s.score.away>s.score.home?'away':'home',e=t.lead?.team===winner?t.lead:null;
 const award=(p,team)=>p?{...p,team,teamName:s.rosters[team].teamName}:null;
 return {winner,automatic:true,trackingComplete:t.complete,winningPitcher:e?award(e.winningPitcher,winner):null,losingPitcher:e?award(e.responsiblePitcher,winner==='away'?'home':'away'):null,winningRbi:e&&e.result!=='MANUAL'?award(e.batter,winner):null,currentPitchers:{away:currentPitcher(s,'away'),home:currentPitcher(s,'home')}};
}
module.exports={ensure,changePitcher,batterRunner,scoring,summary,pitch,appearance,currentPitcher};
