// Public bylines and numeric bid guidance only; article prose is never republished.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const DAY=86400000;
export const SOURCES={
 fp:{author:'Pat Fitzmaurice',label:'FantasyPros',format:'redraft',host:'www.fantasypros.com'},
 ft:{author:'Jon Woods',label:'FFToday',format:'redraft',host:'www.fftoday.com'},
 dn:{author:'Mychal Warno',label:'Dynasty Nerds',format:'dynasty',host:'www.dynastynerds.com'}
};
export const plain=s=>String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/\s+/g,' ').trim();
const rankName=s=>plain(s).toLowerCase().replace(/[^a-z0-9]/g,'');
function assertContext({season,week}){if(!Number.isInteger(season)||season<2020||season>2100||!Number.isInteger(week)||week<1||week>18)throw Error('Invalid season/week');}
export function validArticleURL(source,url,ctx){
 try{assertContext(ctx);const u=new URL(url),{season,week}=ctx;if(u.protocol!=='https:'||u.hostname!==SOURCES[source]?.host||u.username||u.password||u.port)return false;
 if(source==='ft')return u.pathname===`/articles/woods/${String(season).slice(-2)}-touch-transfer-wk${week}.html`;
 if(source==='fp')return new RegExp(`^/${season}/\\d{2}/fantasy-football-waiver-wire-advice-players-to-add-stash-drop-week-${week}-${season}/?$`).test(u.pathname);
 return new RegExp(`^/waiver-wire/week-${week}-waiver-wire(?:-[a-z0-9]+)*-${season}/?$`).test(u.pathname);
 }catch{return false;}
}
function metadata(html){
 const objects=[];for(const script of html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)||[]){try{const j=JSON.parse(script.replace(/^.*?>/s,'').replace(/<\/script>$/i,''));objects.push(...(Array.isArray(j)?j:[j]),...(j['@graph']||[]));}catch{}}
 const article=objects.find(x=>[x['@type']].flat().some(t=>['Article','NewsArticle','BlogPosting'].includes(t)));
 const metaAuthor=html.match(/<meta\b[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i)?.[1];
 const authorRef=article?.author?.['@id'],linked=authorRef?objects.find(x=>x['@id']===authorRef):null;
 return {date:article?.datePublished,author:article?.author?.name||linked?.name||metaAuthor};
}
export function parse(source,html,{season,week,url,players=[],now=Date.now()}){
 const ctx={season,week};assertContext(ctx);if(!validArticleURL(source,url,ctx))throw Error('Wrong article origin or period in URL');
 const title=plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
 if(!new RegExp('Week\\s*'+week+'\\b','i').test(title))throw Error('Wrong article week');
 if((title.match(/\b20\d{2}\b/g)||[]).some(y=>Number(y)!==season))throw Error('Wrong article year');
 const canonical=html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
 if(canonical&&!validArticleURL(source,canonical,ctx))throw Error('Canonical URL has wrong source or period');
 const meta=metadata(html),text=plain(html);
 // FFToday's visible dated byline is its primary metadata; the other two sites
 // expose article-specific structured author/date fields. Sidebar names do not qualify.
 const ftByline=source==='ft'?text.match(/(?:By\s*:\s*|By\s+)?(Jon Woods)\s*\|\s*Updated:\s*(\d{1,2}\/\d{1,2}\/\d{2})/i):null;
 const stamp=meta.date||ftByline?.[2],parts=ftByline?.[2]?.split('/'),publishedAt=parts&&!meta.date?new Date(Date.UTC(2000+Number(parts[2]),Number(parts[0])-1,Number(parts[1]))):new Date(stamp||'invalid');
 if(!Number.isFinite(+publishedAt)||publishedAt.getUTCFullYear()!==season||+publishedAt>now+300000||now-publishedAt>10*DAY)throw Error('Article date is not current');
 const config=SOURCES[source];if(plain(meta.author||ftByline?.[1]||'')!==config.author)throw Error('Article author not verified');
 const articleURL=new URL(canonical||url);articleURL.search='';articleURL.hash='';
 const rows=[],base={sourceId:source,author:config.author,source:config.label,format:config.format,url:articleURL.href,publishedAt:publishedAt.toISOString(),retrievedAt:new Date(now).toISOString(),note:'Published waiver guidance; not a measured winning bid.'};
 if(source==='ft'){
  if(!/\$200/.test(text))throw Error('Missing budget basis');
  for(const block of html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi)||[]){const t=plain(block),m=t.match(/^(QB|RB|WR|TE)\s+(.+?),.*?Suggested FAAB:\s*\$(\d+)\s*[-–]\s*\$(\d+)/);if(m){const conditional=/Suggested FAAB:[\s\S]*\b(?:if|when|unless|assuming)\b/i.test(t);rows.push({...base,name:m[2].trim(),pos:m[1],low:+m[3],high:+m[4],budgetBasis:200,conditional,bidText:`$${m[3]}–$${m[4]} on $200 starting budget${conditional?'; conditional—read source':''}`});}}
 }else if(source==='dn'){
  // Prefer the public summary table above the individual writeups. This also
  // avoids relying on the directory matching a newly added or renamed player.
  for(const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi)||[]){
   const tr=table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[],headers=(tr[0]?.match(/<th\b[^>]*>[\s\S]*?<\/th>/gi)||[]).map(plain);
   if(headers.join('|')!=='Player|Pos|Team|Roster %|FAAB')continue;
   for(const row of tr.slice(1)){const c=(row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi)||[]).map(plain),bid=c[4]?.match(/^(\d+)(?:[-–](\d+))?%$/);if(c.length===5&&/^(QB|RB|WR|TE)$/.test(c[1])&&bid)rows.push({...base,name:c[0],pos:c[1],low:+bid[1],high:+(bid[2]||bid[1]),budgetBasis:null,bidText:`${bid[1]}${bid[2]?'–'+bid[2]:''}% FAAB; initial versus remaining basis unspecified`,leagueContext:'12-team superflex PPR dynasty'});}
  }
  // Historical public pages used headings and no summary table. Never fetch a
  // login/alternate representation to obtain missing article content.
  if(!rows.length)for(const block of html.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)||[]){const m=plain(block).match(/^(.+?)\s*\|.*?\|.*?Rostership\s*\|\s*(\d+)(?:[-–](\d+))?%\s*FAAB/i);if(!m)continue;const matches=players.filter(p=>rankName(p.full_name||[p.first_name,p.last_name].filter(Boolean).join(' '))===rankName(m[1])),positions=[...new Set(matches.map(p=>p.position))];if(positions.length!==1||!/^(QB|RB|WR|TE)$/.test(positions[0]))continue;rows.push({...base,name:m[1].trim(),pos:positions[0],low:+m[2],high:+(m[3]||m[2]),budgetBasis:null,bidText:`${m[2]}${m[3]?'–'+m[3]:''}% FAAB; initial versus remaining basis unspecified`});}
 }else{
  if(!/bids are based on a \$100 budget/i.test(text))throw Error('Missing budget basis');
  for(const block of html.split(/(?=<h4\b)/i)){const heading=block.match(/^<h4\b[^>]*>([\s\S]*?)<\/h4>/i);if(!heading)continue;const m=plain(heading[1]).match(/^(.+?)\s*\((QB|RB|WR|TE)\s*[–-]/);if(!m)continue;const t=plain(block),value=t.match(/True Value\s*:\s*\$(\d+)/i),low=t.match(/Budget-Minded\s*:\s*\$(\d+)/i),high=t.match(/Desperate Need\s*:\s*\$(\d+)/i);if(value&&low&&high)rows.push({...base,name:m[1],pos:m[2],low:+low[1],high:+high[1],typical:+value[1],budgetBasis:100,bidText:`$${low[1]} budget / $${value[1]} typical / $${high[1]} urgent on stated $100 budget`});}
 }
 const unique=new Map();for(const r of rows){if(r.low<0||r.high<r.low||r.high>(r.budgetBasis||100)||r.typical!=null&&(r.typical<r.low||r.typical>r.high))throw Error('Invalid numeric bid range');unique.set(rankName(r.name)+'|'+r.pos,r);}
 if(!unique.size)throw Error('No explicit bids parsed');return [...unique.values()];
}
export function sourceURLs(source,{season,week,now=Date.now()}){
 assertContext({season,week});
 if(source==='ft')return [`https://${SOURCES.ft.host}/articles/woods/${String(season).slice(-2)}-touch-transfer-wk${week}.html`];
 if(source==='dn')return [`https://${SOURCES.dn.host}/waiver-wire/week-${week}-waiver-wire-faab-guide-${season}/`,`https://${SOURCES.dn.host}/waiver-wire/week-${week}-waiver-wire-${season}/`];
 // Waiver articles can be published in the previous month at a month boundary.
 const d=new Date(now),months=[d.getUTCMonth()+1,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),0)).getUTCMonth()+1];
 return [...new Set(months)].map(m=>`https://${SOURCES.fp.host}/${season}/${String(m).padStart(2,'0')}/fantasy-football-waiver-wire-advice-players-to-add-stash-drop-week-${week}-${season}/`);
}
export function discoverDN(html,ctx){
 const result=[];for(const m of html.matchAll(/href=["']([^"']+)["']/gi)){try{const u=new URL(m[1],`https://${SOURCES.dn.host}/waiver-wire/`);u.hash='';u.search='';if(validArticleURL('dn',u.href,ctx)&&!result.includes(u.href))result.push(u.href);}catch{}}
 return result.slice(0,4);
}
export async function collect({season,week,players=[],old=null,now=Date.now(),get}){
 const ctx={season,week,players,now};assertContext(ctx);const rows=[],failures=[],sourceStatus=[];
 for(const source of Object.keys(SOURCES)){
  const attempts=[],tried=new Set();let got=null;
  const tryURLs=async urls=>{for(const url of urls){if(tried.has(url))continue;tried.add(url);try{const response=await get(url),resolved=response.url||url;if(!validArticleURL(source,resolved,ctx))throw Error('Redirect has wrong source or period');got=parse(source,await response.text(),{...ctx,url:resolved});return;}catch(e){attempts.push({url,error:e.message});}}};
  await tryURLs(sourceURLs(source,ctx));
  if(!got&&source==='dn'){
   const index=`https://${SOURCES.dn.host}/waiver-wire/`;
   try{const page=await get(index);if(new URL(page.url||index).origin!==new URL(index).origin)throw Error('Discovery redirected off source');const candidates=discoverDN(await page.text(),ctx).filter(u=>!tried.has(u)).slice(0,2);await tryURLs(candidates);}catch(e){attempts.push({url:index,error:e.message});}
  }
  if(got){rows.push(...got);sourceStatus.push({source,status:'current',rows:got.length,retrievedAt:new Date(now).toISOString(),url:got[0].url,attempts});continue;}
  // Retain only same-period rows and preserve original retrieval/publication
  // times. A successful neighbor must not make this source look refreshed.
  const retained=old?.season===season&&old?.week===week?(old.rows||[]).filter(r=>(r.sourceId===source||!r.sourceId&&r.source===SOURCES[source].label)&&r.author===SOURCES[source].author&&validArticleURL(source,r.url,ctx)&&Number.isFinite(Date.parse(r.publishedAt))&&new Date(r.publishedAt).getUTCFullYear()===season&&Date.parse(r.publishedAt)<=now+300000&&now-Date.parse(r.publishedAt)<=10*DAY).map(r=>({...r,sourceId:source,retained:true,retrievedAt:r.retrievedAt||old.generatedAt})):[];
  rows.push(...retained);const failure={source,url:sourceURLs(source,ctx)[0],error:'No verified current article',attempts,retainedRows:retained.length};failures.push(failure);sourceStatus.push({source,status:retained.length?'retained':'failed',rows:retained.length,attempts});
 }
 return {version:2,season,week,generatedAt:new Date(now).toISOString(),rows,failures,sourceStatus};
}
export function targetWeek(state,board){
 const season=Number(state?.season),week=Number(state?.week??state?.leg??state?.display_week);assertContext({season,week});if(state.season_type!=='regular')throw Error('No regular-season waiver period');
 // On Monday after every game completes, get next week's column. On Tuesday
 // Sleeper already advances week, so display_week must not send us backwards.
 const matches=Number(board?.season?.year)===season&&Number(board?.season?.type)===2&&Number(board?.week?.number)===week;
 const next=matches&&board.events?.length&&board.events.every(e=>e.status?.type?.completed===true)?week+1:week;
 if(next>18)throw Error('No next regular-season waiver period');return next;
}
async function getPublic(url){const r=await fetch(url,{headers:{'User-Agent':'DraftDesk/113 public-waiver-research'},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('HTTP '+r.status);return r;}
export async function main({get=getPublic,out='data',now=Date.now()}={}){
 const state=await(await get('https://api.sleeper.app/v1/state/nfl')).json(),season=Number(state.season),rawWeek=Number(state.week??state.leg??state.display_week);assertContext({season,week:rawWeek});
 let board=null;try{board=await(await get(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${rawWeek}`)).json();}catch{}
 const week=targetWeek(state,board);
 let old=null,players=[];try{old=JSON.parse(await readFile(join(out,'waiver-evidence.json'),'utf8'));}catch{}
 try{players=Object.values(await(await get('https://api.sleeper.app/v1/players/nfl')).json());}catch{}
 const output=await collect({season,week,players,old,now,get});
 await mkdir(out,{recursive:true});await writeFile(join(out,'waiver-evidence.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({season,week,rows:output.rows.length,failures:output.failures,sourceStatus:output.sourceStatus}));return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(output=>{if(!output.rows.length)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;});
