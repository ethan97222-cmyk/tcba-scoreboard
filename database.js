const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const normalize=value=>String(value??'').normalize('NFKC').trim();
class TournamentDatabase {
 constructor(file){
  this.file=file;this.db=new DatabaseSync(file);
  this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS tournaments(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,tournament_id TEXT NOT NULL REFERENCES tournaments(id),team_name TEXT NOT NULL,number TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(tournament_id,team_name,number,name));
   CREATE TABLE IF NOT EXISTS player_aliases(tournament_id TEXT NOT NULL,client_id TEXT NOT NULL,player_id TEXT NOT NULL REFERENCES players(id),PRIMARY KEY(tournament_id,client_id));
   CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,tournament_id TEXT NOT NULL REFERENCES tournaments(id),status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,state_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS player_match_stats(match_id TEXT NOT NULL REFERENCES matches(id),player_id TEXT NOT NULL REFERENCES players(id),pa INTEGER NOT NULL DEFAULT 0,ab INTEGER NOT NULL DEFAULT 0,h INTEGER NOT NULL DEFAULT 0,hr INTEGER NOT NULL DEFAULT 0,bb INTEGER NOT NULL DEFAULT 0,k INTEGER NOT NULL DEFAULT 0,doubles INTEGER NOT NULL DEFAULT 0,triples INTEGER NOT NULL DEFAULT 0,pitches INTEGER NOT NULL DEFAULT 0,pitch_k INTEGER NOT NULL DEFAULT 0,pitch_bb INTEGER NOT NULL DEFAULT 0,pitch_complete INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(match_id,player_id));
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS matches_tournament ON matches(tournament_id,status);
   CREATE INDEX IF NOT EXISTS player_stats_player ON player_match_stats(player_id);`);
  this.db.prepare('INSERT OR IGNORE INTO tournaments VALUES(?,?,?)').run('ntut-cup','NTUT CUP',new Date().toISOString());
 }
 list(){return this.db.prepare('SELECT id,name FROM tournaments ORDER BY created_at').all();}
 create(name){name=normalize(name);if(!name||name.length>60)throw Error('請填 1–60 字的賽會名稱');const id=randomUUID();this.db.prepare('INSERT INTO tournaments VALUES(?,?,?)').run(id,name,new Date().toISOString());return {id,name};}
 tournament(id){const row=this.db.prepare('SELECT id,name FROM tournaments WHERE id=?').get(id);if(!row)throw Error('找不到賽會');return row;}
 active(){const row=this.db.prepare("SELECT value FROM metadata WHERE key='active_match'").get();if(!row)return null;const match=this.db.prepare('SELECT state_json FROM matches WHERE id=?').get(row.value);return match?JSON.parse(match.state_json):null;}
 match(id,tournament){const row=this.db.prepare('SELECT state_json FROM matches WHERE id=? AND tournament_id=?').get(id,tournament);if(!row)throw Error('找不到此賽會的比賽');return JSON.parse(row.state_json);}
 bind(tournament,team,p){
  const values=[tournament,normalize(team),normalize(p.no),normalize(p.name)];
  let row=this.db.prepare('SELECT id FROM players WHERE tournament_id=? AND team_name=? AND number=? AND name=?').get(...values);
  if(!row){row={id:randomUUID()};this.db.prepare('INSERT INTO players VALUES(?,?,?,?,?)').run(row.id,...values);}
  if(p.id)this.db.prepare('INSERT INTO player_aliases VALUES(?,?,?) ON CONFLICT(tournament_id,client_id) DO UPDATE SET player_id=excluded.player_id').run(tournament,p.id,row.id);
  p.playerId=row.id;return row.id;
 }
 alias(tournament,id){return this.db.prepare('SELECT player_id FROM player_aliases WHERE tournament_id=? AND client_id=?').get(tournament,id)?.player_id;}
 save(s){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   s.tournament=this.tournament(s.tournament?.id||'ntut-cup');s.matchId ||= randomUUID();s.createdAt ||= new Date().toISOString();
   const existing=this.db.prepare('SELECT tournament_id FROM matches WHERE id=?').get(s.matchId);if(existing&&existing.tournament_id!==s.tournament.id)throw Error('比賽已屬於另一個賽會，不能重複匯入到不同賽會');
   const rows=new Map();
   const entry=id=>{if(!rows.has(id))rows.set(id,{pa:0,ab:0,h:0,hr:0,bb:0,k:0,doubles:0,triples:0,pitches:0,pitch_k:0,pitch_bb:0,pitch_complete:1});return rows.get(id);};
   for(const team of ['away','home']){
    for(const p of [...s.rosters[team].lineup,...(s.retired?.[team]||[])]){
     const id=this.bind(s.tournament.id,s.rosters[team].teamName,p),r=entry(id);
     for(const result of p.results||[]){r.pa++;if(result!=='BB')r.ab++;if(['1B','2B','3B','HR','H'].includes(result))r.h++;if(result==='HR')r.hr++;if(result==='BB')r.bb++;if(result==='K')r.k++;if(result==='2B')r.doubles++;if(result==='3B')r.triples++;}
    }
    const pitcher=s.tracking?.pitchers?.[team];if(pitcher&&!this.alias(s.tournament.id,pitcher.id))this.bind(s.tournament.id,s.rosters[team].teamName,pitcher);
   }
   for(const [key,value] of Object.entries(s.tracking?.pitchStats||{})){
    const clientId=key.slice(key.indexOf(':')+1),id=this.alias(s.tournament.id,clientId);if(!id)continue;
    const r=entry(id);r.pitches+=value.pitches||0;r.pitch_k+=value.k||0;r.pitch_bb+=value.bb||0;if(!value.complete)r.pitch_complete=0;
   }
   this.db.prepare(`INSERT INTO matches VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,state_json=excluded.state_json`).run(s.matchId,s.tournament.id,s.ended?'final':'live',s.createdAt,new Date().toISOString(),JSON.stringify(s));
   this.db.prepare('DELETE FROM player_match_stats WHERE match_id=?').run(s.matchId);
   const insert=this.db.prepare('INSERT INTO player_match_stats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
   for(const [id,r] of rows)insert.run(s.matchId,id,r.pa,r.ab,r.h,r.hr,r.bb,r.k,r.doubles,r.triples,r.pitches,r.pitch_k,r.pitch_bb,r.pitch_complete);
   this.db.prepare("INSERT INTO metadata VALUES('active_match',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(s.matchId);
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 totals(tournament,currentMatch){
  const rows=this.db.prepare(`SELECT p.id,p.name,p.number AS no,p.team_name AS teamName,COUNT(DISTINCT m.id) AS games,SUM(s.pa) AS pa,SUM(s.ab) AS ab,SUM(s.h) AS h,SUM(s.hr) AS hr,SUM(s.bb) AS bb,SUM(s.k) AS k,SUM(s.doubles) AS doubles,SUM(s.triples) AS triples,SUM(s.pitches) AS pitches,SUM(s.pitch_k) AS pitchK,SUM(s.pitch_bb) AS pitchBB,MIN(s.pitch_complete) AS pitchComplete FROM player_match_stats s JOIN players p ON p.id=s.player_id JOIN matches m ON m.id=s.match_id WHERE p.tournament_id=? AND (m.status='final' OR m.id=?) GROUP BY p.id ORDER BY p.team_name,p.number,p.name`).all(tournament,currentMatch||'');
  return rows.map(r=>({...r,avg:r.ab?(r.h/r.ab).toFixed(3):'—',pitchComplete:Boolean(r.pitchComplete)}));
 }
 view(s){const players=this.totals(s.tournament.id,s.matchId);const byClientId=Object.fromEntries(this.db.prepare('SELECT client_id,player_id FROM player_aliases WHERE tournament_id=?').all(s.tournament.id).map(row=>[row.client_id,players.find(p=>p.id===row.player_id)]));return {...s.tournament,players,byClientId,matches:this.db.prepare('SELECT id,status,created_at,state_json FROM matches WHERE tournament_id=? ORDER BY created_at DESC').all(s.tournament.id).map(m=>{const g=JSON.parse(m.state_json);return {id:m.id,status:m.status,date:m.created_at,away:g.rosters.away.teamName,home:g.rosters.home.teamName,score:g.score};})};}
 importMatch(s){if(!s?.rosters||!s?.score||!s.ended)throw Error('請匯入已結束比賽的完整 JSON 紀錄');s.matchId ||= require('crypto').createHash('sha256').update(JSON.stringify(s)).digest('hex');const active=this.active();this.save(s);if(active)this.db.prepare("UPDATE metadata SET value=? WHERE key='active_match'").run(active.matchId);return s.matchId;}
 backup(file){const result=this.db.prepare('PRAGMA wal_checkpoint(FULL)').get();if(result.busy)throw Error('資料庫正被使用，請稍後再備份');require('fs').copyFileSync(this.file,file);}
 close(){this.db.close();}
}
module.exports={TournamentDatabase};
