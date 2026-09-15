// Public metadata and numeric bid guidance only. No article bodies are republished.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const plain=s=>s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/\s+/g,' ').trim();
export function parse(source,html,{season,week,url,players=[]}){
 const title=plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
 if(!new RegExp('Week\\s*'+week+'\\b','i').test(title))throw Error('Wrong article week');
 const stamp=html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]||html.match(/\b(\d{1,2}\/\d{1,2}\/\d{2})\b/)?.[1];
 const publishedAt=new Date(stamp||'invalid');if(!Number.isFinite(+publishedAt)||publishedAt.getUTCFullYear()!==season||+publishedAt>Date.now()+300000||Date.now()-publishedAt>10*86400000)throw Error('Article date is not current');
 const authors={ft:['Jon Woods','FFToday','redraft'],dn:['Mychal Warno','Dynasty Nerds','dynasty'],fp:['Pat Fitzmaurice','FantasyPros','redraft']};
 const [author,label,format]=authors[source];if(!plain(html).includes(author))throw Error('Author not verified');
 const rows=[],base={author,source:label,format,url,publishedAt:publishedAt.toISOString(),note:'Published waiver guidance; not a measured winning bid.'};
 if(source==='ft'){
  if(!/\$200/.test(html))throw Error('Missing budget basis');
  for(const block of html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi)||[]){const text=plain(block),m=text.match(/^(QB|RB|WR|TE)\s+(.+?),.*?Suggested FAAB:\s*\$(\d+)\s*[-–]\s*\$(\d+)/);if(m)rows.push({...base,name:m[2],pos:m[1],low:+m[3],high:+m[4],budgetBasis:200,bidText:`$${m[3]}–$${m[4]} on $200 starting budget`});}
 }else if(source==='dn'){
  for(const block of html.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)||[]){const text=plain(block),m=text.match(/^(.+?)\s*\|.*?\|.*?Rostership\s*\|\s*(\d+)(?:[-–](\d+))?%\s*FAAB/i);if(!m)continue;const matches=players.filter(p=>(p.full_name||[p.first_name,p.last_name].filter(Boolean).join(' ')).toLowerCase()===m[1].trim().toLowerCase());const positions=[...new Set(matches.map(p=>p.position))];if(positions.length!==1)continue;rows.push({...base,name:m[1].trim(),pos:positions[0],low:+m[2],high:+(m[3]||m[2]),budgetBasis:null,bidText:`${m[2]}${m[3]?'–'+m[3]:''}% FAAB; initial versus remaining basis unspecified`});}
 }else{
  if(!/bids are based on a \$100 budget/i.test(plain(html)))throw Error('Missing budget basis');
  const blocks=html.split(/(?=<h4\b)/i);
  for(const block of blocks){const heading=block.match(/^<h4\b[^>]*>([\s\S]*?)<\/h4>/i);if(!heading)continue;const m=plain(heading[1]).match(/^(.+?)\s*\((QB|RB|WR|TE)\s*[–-]/);if(!m)continue;const text=plain(block),value=text.match(/True Value\s*:\s*\$(\d+)/i),low=text.match(/Budget-Minded\s*:\s*\$(\d+)/i),high=text.match(/Desperate Need\s*:\s*\$(\d+)/i);if(value&&low&&high)rows.push({...base,name:m[1],pos:m[2],low:+low[1],high:+high[1],typical:+value[1],budgetBasis:100,bidText:`$${low[1]} budget / $${value[1]} typical / $${high[1]} urgent on $100 starting budget`});}
 }
 if(!rows.length)throw Error('No explicit bids parsed');return rows;
}
export async function main(){const get=async url=>{const r=await fetch(url,{headers:{'User-Agent':'DraftDesk/107 public-waiver-research'},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('HTTP '+r.status);return r;};
 const state=await (await get('https://api.sleeper.app/v1/state/nfl')).json(),season=Number(state.season);let week=Number(state.display_week||state.week);
 const board=await (await get(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`)).json();if(board.events?.length&&board.events.every(e=>e.status?.type?.completed))week++;
 if(state.season_type!=='regular'||week<1||week>18)throw Error('No next regular-season waiver period');
 const players=Object.values(await (await get('https://api.sleeper.app/v1/players/nfl')).json()),month=String(new Date().getUTCMonth()+1).padStart(2,'0');
 const sources=[['fp',`https://www.fantasypros.com/${season}/${month}/fantasy-football-waiver-wire-advice-players-to-add-stash-drop-week-${week}-${season}/`],['ft',`https://www.fftoday.com/articles/woods/${String(season).slice(-2)}-touch-transfer-wk${week}.html`],['dn',`https://www.dynastynerds.com/waiver-wire/week-${week}-waiver-wire-${season}/`]];
 const rows=[],failures=[];
 for(const [source,url]of sources){try{rows.push(...parse(source,await(await get(url)).text(),{season,week,url,players}));}catch(e){failures.push({source,url,error:e.message});}}
 if(!rows.length)throw Error('No current public waiver columns; retain last good file');
 // Preserve a source's last good current-week rows when that source fails briefly.
 try{const old=JSON.parse(await readFile('data/waiver-evidence.json','utf8'));if(old.season===season&&old.week===week){const failedURLs=new Set(failures.map(f=>f.url));rows.push(...old.rows.filter(r=>failedURLs.has(r.url)));}}catch{}
 const output={version:1,season,week,generatedAt:new Date().toISOString(),rows,failures};await mkdir('data',{recursive:true});await writeFile('data/waiver-evidence.json',JSON.stringify(output,null,2));console.log(JSON.stringify({season,week,rows:rows.length,failures}));return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});

