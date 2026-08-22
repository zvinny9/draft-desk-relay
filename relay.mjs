#!/usr/bin/env node
/* Draft Desk relay.
 *
 * Fetches the market sources that refuse a browser and writes them as JSON into
 * this repo. Draft Desk then reads those files over raw.githubusercontent.com,
 * which is the one host proven to serve a page opened from file:// — it sends
 * Access-Control-Allow-Origin: *.
 *
 * There is no key and no secret. GitHub Actions supplies its own token for the
 * commit, and every source below is a public page. Nothing here is typed in by
 * hand and nothing here needs anything of yours.
 *
 * Run: node relay.mjs [outDir]      (default: ./data)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = process.argv[2] || "data";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const SEASON = Number(process.env.SEASON) || new Date().getFullYear();

const log = (...a) => console.log("[relay]", ...a);

async function get(url, kind = "text") {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return kind === "json" ? r.json() : r.text();
}

/* Envelope. Every file looks the same so the app needs one reader and can
   always answer "how old is this" without knowing what the payload is. */
async function publish(name, rows, source, note, extra = {}) {
  await mkdir(OUT, { recursive: true });
  const body = { at: Date.now(), generated: new Date().toISOString(), season: SEASON,
    source, note: note || "", count: rows.length, rows, ...extra };
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(body, null, 1));
  log(`wrote ${name}.json — ${rows.length} rows from ${source}`);
}

/* ---------- helpers ---------- */
const TEAMS = new Set(["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB",
  "HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SF",
  "SEA","TB","TEN","WAS","LA"]);
const POS = /^(QB|RB|WR|TE|K|PK|DST|D\/ST|DEF)$/i;

/* Strip tags, keep cell boundaries. Good enough for a table and far more robust
   than a DOM parser we would have to install. */
function tableRows(html) {
  const out = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
      c.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
       .replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim());
    if (cells.length) out.push(cells);
  }
  return out;
}

/* Read an ADP table by CONTENT rather than by header index. These sites ship
   unheadered image columns and reorder without warning; the name is the cell
   that looks like a person, the ADP is the last decimal after it. */
function adpFromRows(rows) {
  const out = [];
  for (const c of rows) {
    if (c.length < 3) continue;
    const nameAt = c.findIndex((x) =>
      /^[A-Za-z][A-Za-z.'\-]*(\s+[A-Za-z][A-Za-z.'\-]*)+/.test(x) && !POS.test(x) && !TEAMS.has(x.toUpperCase()));
    if (nameAt < 0) continue;
    const name = c[nameAt];
    const after = c.slice(nameAt + 1).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? parseFloat(x) : null)).filter((x) => x != null);
    const dec = after.filter((x) => !Number.isInteger(x));
    const adp = dec.length ? dec[dec.length - 1] : after.length ? after[after.length - 1] : null;
    if (!(adp > 0)) continue;
    out.push({ name, adp,
      pos: (c.find((x) => POS.test(x)) || "").toUpperCase().replace("D/ST", "DST").replace("PK", "K") || null,
      team: c.find((x) => TEAMS.has(x.toUpperCase()))?.toUpperCase() || null });
  }
  return out;
}

/* ---------- sources ---------- */

/* FFPC. Measured 22 Aug 2026, not guessed. The League Type picker never touches
   the URL; the page posts nothing either. It issues

     GET /FFPCADPReport.ashx?draftStartDateFrom=..&draftStartDateTo=..
         &leagueTypeID=N | &leagueGroupID=N
         &superflexFilter=0|1&slimRostersFilter=0|1

   and gets back XML: <data><players><player name= nflTeam= position= adp=
   min= max= leaguesDraftedIn= .../></players></data>. The contest is a numeric
   id and the picker's own script carries the table; two different KINDS of id
   share one report, so a contest is { param, id } here rather than a bare
   number. Proof the filter is real: superflex (55) puts Josh Allen at 2.12 and
   no other board has a quarterback in its top five. */
const FFPC_XML = /<player\b([^>]*)\/?>/gi;
/* The report is XML, so apostrophes arrive escaped. Ja&apos;Marr Chase does not
   match Ja'Marr Chase in any name table Draft Desk has, and the miss is silent:
   the player simply never gets an FFPC ADP. */
const unxml = (s) => s.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (s, k) => {
  const m = s.match(new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? unxml(m[1]) : null;
};
function ffpcRows(xml) {
  const out = [];
  let m;
  FFPC_XML.lastIndex = 0;
  while ((m = FFPC_XML.exec(xml))) {
    const a = m[1];
    const name = attr(a, "name"), adp = Number(attr(a, "adp"));
    /* MEASURED: the report returns the whole player universe and pads everyone
       who was not actually drafted to a flat adp of 350 — 2155 of 2466 rows on
       the Main Event board. Publishing those would hand Draft Desk two thousand
       identical fake ADPs that look exactly like a market. Only rows with a
       league count behind them are real. */
    const leagues = Number(attr(a, "leaguesDraftedIn")) || 0;
    if (!name || !(adp > 0) || leagues < 1) continue;
    out.push({ name, adp, pos: attr(a, "position"), team: attr(a, "nflTeam"), leagues });
  }
  return out;
}

/* A wide window on purpose. The page defaults to the last seven days, which for
   Main Event was 22 leagues on the day this was written — an ADP with a sample
   of 22 is noise. From July gives 79 there and 710 on the superflex board. */
const ffpcWindow = () => {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date();
  const f = (x) => `${String(x.getDate()).padStart(2, "0")}${M[x.getMonth()]}${x.getFullYear()}`;
  return `draftStartDateFrom=01Jul${SEASON}&draftStartDateTo=${f(d)}`;
};

async function ffpc(kind, contest) {
  const q = `${ffpcWindow()}&${contest.param}=${contest.id}` +
    `&superflexFilter=${contest.sf ? 1 : 0}&slimRostersFilter=${contest.slim ? 1 : 0}`;
  const xml = await get(`https://myffpc.com/FFPCADPReport.ashx?${q}`);
  const rows = ffpcRows(xml);
  if (rows.length <= 50) throw new Error(`${contest.label}: only ${rows.length} players actually drafted`);
  const n = rows[0].leagues;
  return { rows: rows.map(({ leagues, ...r }) => r),
    source: `myffpc.com ${contest.label}`,
    note: n ? `${n} leagues behind the top pick, drafts since 1 Jul` : "" };
}

/* NFFC. Also measured. /adp/football serves "Loading..." and nothing else — the
   table is drawn client-side from

     POST /adp.data.php   sport=football&draft_type=N&num_teams=0&...

   which answers with bare <tr> fragments, no <table> around them. The sport
   field is not optional: the same endpoint with no body returns BASEBALL, which
   is how the first version of this file quietly published Shohei Ohtani.
   draft_type 0 is every non-auction draft; the numbered contests are NFFC's
   own ids, read off the picker. */
const NFFC_CONTESTS = { all: 0, superflex: 961, primetime: 941, classic: 935 };

async function nffc(draftType = NFFC_CONTESTS.all) {
  const body = new URLSearchParams({ team_id: "0", time_period: "", from_date: "",
    to_date: "", num_teams: "0", draft_type: String(draftType), sport: "football",
    position: "", league_teams: "", as_board: "0" }).toString();
  const r = await fetch("https://nfc.shgn.com/adp.data.php", { method: "POST",
    headers: { "user-agent": UA, "x-requested-with": "XMLHttpRequest",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }, body });
  if (!r.ok) throw new Error(`adp.data.php -> ${r.status}`);
  const rows = adpFromRows(tableRows(await r.text()));
  if (rows.length <= 50) throw new Error(`${rows.length} rows back from adp.data.php`);
  /* Cheap guard against the wrong sport coming back: an NFL board is almost all
     one of six positions, a baseball board is almost none of them. */
  const known = rows.filter((x) => x.pos).length / rows.length;
  if (known < 0.5) throw new Error(`only ${Math.round(known * 100)}% of rows carry an NFL position`);
  return { rows, source: "nfc.shgn.com adp.data.php" };
}

/* Underdog. The host matters and it is not the obvious one: api.underdogfantasy
   .com is the ACCOUNT api and 404s every ADP path (four of them, in run #1 of
   this workflow). The public board lives on stats.underdogfantasy.com, which
   Draft Desk already reads directly in the browser because that host does send
   Access-Control-Allow-Origin: *. This job is therefore a backstop rather than
   the primary path, and it uses the same three calls the app uses. */
const UD = "https://stats.underdogfantasy.com";
const UD_Q = "?product=SEASON_LONG&product_experience_id=1";
const UD_SCORING = "ccf300b0-9197-5951-bd96-cba84ad71e86";

async function underdog() {
  const slates = await get(`${UD}/v1/sports/nfl/slates${UD_Q}`, "json");
  const list = slates.slates || slates.data || (Array.isArray(slates) ? slates : []);
  const slate = list.find((s) => /^\d{4} season$/i.test(String(s.title || s.name || "").trim()))
    || list[0];
  if (!slate) throw new Error("no season slate listed");
  const app = await get(`${UD}/v1/slates/${slate.id}/scoring_types/${UD_SCORING}/appearances${UD_Q}`, "json");
  const arr = app.appearances || app.data || (Array.isArray(app) ? app : []);
  const rows = arr.map((r) => {
    const p = r.player || r;
    return { name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      adp: Number(r.adp ?? r.average_draft_position ?? p.adp),
      pos: p.position || p.slot || null, team: p.team_name || p.team || null };
  }).filter((r) => r.name && r.adp > 0);
  if (rows.length <= 50) throw new Error(`${rows.length} appearances back for ${slate.title || slate.id}`);
  return { rows, source: `underdog ${slate.title || slate.id}` };
}

/* Posted season win totals with both prices. nflverse publishes exactly this
   schema and stops short of the current season, so it is tried and then a live
   scrape is tried behind it. Only genuinely POSTED numbers are written here —
   Draft Desk pins its Vegas weight at zero for anything derived, so publishing
   a derivation into this file would defeat the point of the file. */
async function wins() {
  try {
    const csv = await get("https://raw.githubusercontent.com/nflverse/nfldata/master/data/win_totals.csv");
    const lines = csv.trim().split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    const rows = lines.slice(1).map((l) => l.split(",")).filter((c) => String(c[ix.season]) === String(SEASON))
      .map((c) => ({ team: c[ix.team], line: Number(c[ix.line]),
        over: c[ix.over_odds] ? Number(c[ix.over_odds]) : null,
        under: c[ix.under_odds] ? Number(c[ix.under_odds]) : null }))
      .filter((r) => r.team && Number.isFinite(r.line));
    if (rows.length >= 20) return { rows, source: "nflverse posted win totals" };
    log(`  wins: nflverse has no ${SEASON} rows yet`);
  } catch (e) { log("  wins: nflverse —", e.message); }
  throw new Error(`no posted ${SEASON} win totals found`);
}

/* ---------- run ---------- */
/* The FFPC contest ids, read off the picker's own script on 22 Aug 2026. Two
   different parameters are in play: Main Event and the tournaments are league
   TYPES, while Chop and the dynasty/best-ball families are league GROUPS. */
const FFPC = {
  mainEvent: { param: "leagueTypeID",  id: 1,  label: "Main Event" },
  chop:      { param: "leagueGroupID", id: 4,  label: "Chop" },
  sfBbt:     { param: "leagueTypeID",  id: 55, label: "Superflex Best Ball Tournament" },
};

const JOBS = [
  ["nffc", () => nffc()],
  ["ffpc", () => ffpc("ffpc", FFPC.mainEvent)],
  ["ffpcchop", () => ffpc("ffpcchop", FFPC.chop)],
  ["ffpcsf", () => ffpc("ffpcsf", FFPC.sfBbt)],
  ["bbsf", () => ffpc("bbsf", FFPC.sfBbt)],
  ["underdog", underdog],
  ["wins", wins],
];

let ok = 0, failed = [];
for (const [name, fn] of JOBS) {
  try {
    const got = await fn();
    await publish(name, got.rows, got.source, got.note, got.tournament ? { tournament: got.tournament } : {});
    ok++;
  } catch (e) {
    /* Deliberately does NOT write an empty file. A source that fails leaves its
       last good file in place and Draft Desk shows that file's real age, which
       is the honest reading — an empty file would present a failure as a market
       with nothing in it. */
    log(`SKIP ${name}: ${e.message}`);
    failed.push(`${name}: ${e.message}`);
  }
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "status.json"), JSON.stringify(
  { at: Date.now(), generated: new Date().toISOString(), season: SEASON, ok, failed }, null, 1));
log(`done — ${ok} of ${JOBS.length} published`);
if (!ok) process.exit(1);
