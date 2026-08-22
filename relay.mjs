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
/* Every site spells the two non-skill positions differently and Draft Desk drops
   a row whose position disagrees with its board - silently, until v80. So the
   relay settles it here, once, rather than letting each source ship its own
   dialect downstream. */
const POS_CANON = { PK: "K", K: "K", "D/ST": "DST", "D-ST": "DST", DEF: "DST", DST: "DST" };
const canonPos = (p) => {
  const u = String(p || "").toUpperCase().trim();
  return POS_CANON[u] || u || null;
};

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
      pos: canonPos(c.find((x) => POS.test(x))),
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
    out.push({ name, adp, pos: canonPos(attr(a, "position")), team: attr(a, "nflTeam"), leagues });
  }
  return out;
}

/* The window is a real trade-off and the first version of this file got it
   wrong in the safe-looking direction.

   The page defaults to the last seven days. On that window Main Event was 22
   leagues, and an ADP built from 22 drafts is noise. So this fetched everything
   since 1 July instead - 79 leagues, a much steadier number, and a number that
   is quietly WRONG for drafting. Eight weeks of drafts blended together lags the
   market: it is still carrying July, before camp, before the depth charts moved.
   Measured against the board's own manually-downloaded FFPC file, the seven-day
   window reproduced it exactly (Gibbs 1.05, Bijan 1.95) while the since-July
   window drifted (Puka 4.27 against 4.75 - most of a round).

   So: start narrow and widen only until the sample is big enough to trust, and
   publish which window was actually used so the app can show it. Recency first,
   sample size as the constraint rather than the goal. */
const FFPC_WINDOWS = [14, 30, 60];
const FFPC_MIN_LEAGUES = 40;
const M3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ddMon = (d) => `${String(d.getDate()).padStart(2, "0")}${M3[d.getMonth()]}${d.getFullYear()}`;
const ffpcWindow = (days) => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 864e5);
  return `draftStartDateFrom=${ddMon(from)}&draftStartDateTo=${ddMon(to)}`;
};

async function ffpc(kind, contest) {
  let best = null;
  for (const days of FFPC_WINDOWS) {
    const q = `${ffpcWindow(days)}&${contest.param}=${contest.id}` +
      `&superflexFilter=${contest.sf ? 1 : 0}&slimRostersFilter=${contest.slim ? 1 : 0}`;
    const rows = ffpcRows(await get(`https://myffpc.com/FFPCADPReport.ashx?${q}`));
    const n = rows.length ? rows[0].leagues : 0;
    log(`  ffpc ${contest.label}: ${days}d -> ${rows.length} players, ${n} leagues`);
    /* Keep the widest attempt as a floor, so a quiet contest still publishes
       something rather than nothing. */
    if (rows.length > 50) best = { rows, n, days };
    if (rows.length > 50 && n >= FFPC_MIN_LEAGUES) break;
  }
  if (!best) throw new Error(`${contest.label}: too few drafts in the last ${FFPC_WINDOWS.at(-1)} days`);
  const thin = best.n < FFPC_MIN_LEAGUES;
  return { rows: best.rows.map(({ leagues, ...r }) => r),
    source: `myffpc.com ${contest.label}`,
    note: `${best.n} leagues, last ${best.days} days${thin ? " \u2014 thin, read it loosely" : ""}` };
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

/* DraftKings. The board's Vegas axis has been dark all season: nflverse's
   win_totals.csv is the only posted source wired up and it has no 2026 rows, so
   `wins` fails every run and Draft Desk pins the Vegas weight at zero. This is
   the live replacement.

   DraftKings' sportscontent API is open - no key, no cookie - and answers with
   the whole content graph for a category: events, markets, selections, plus an
   index of every OTHER category. That index is the useful part, because the
   numeric id for season win totals is DraftKings' to change and has changed
   before. So nothing here hardcodes it. One known-good category is fetched
   purely to read the index off it, the index is filtered by NAME, and the
   win-total market is then recognised by its SHAPE: selections labelled Over
   and Under, against a line between 1 and 17, on something that resolves to an
   NFL team. If DraftKings renumbers tomorrow, this still finds it. */
const DK = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/88808";

const dkLine = (sel) => {
  for (const k of ["points", "line", "handicap"]) {
    const v = Number(sel && sel[k]);
    if (Number.isFinite(v)) return v;
  }
  const m = String((sel && sel.label) || "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const dkPrice = (sel) => {
  const o = sel && (sel.displayOdds || sel.trueOdds || sel.odds);
  const raw = o && (o.american ?? o.americanOdds ?? o);
  const txt = String(raw == null ? "" : raw).trim();
  const n = Number(txt.replace(/[+\s,]/g, ""));
  return Number.isFinite(n) && txt ? n : null;
};

/* DraftKings writes full club names; Draft Desk wants the three-letter code.
   Matched on the nickname, so "New York Giants", "NY Giants" and "Giants" all
   land on NYG. */
const DK_NICK = { cardinals: "ARI", falcons: "ATL", ravens: "BAL", bills: "BUF",
  panthers: "CAR", bears: "CHI", bengals: "CIN", browns: "CLE", cowboys: "DAL",
  broncos: "DEN", lions: "DET", packers: "GB", texans: "HOU", colts: "IND",
  jaguars: "JAX", chiefs: "KC", raiders: "LV", chargers: "LAC", rams: "LAR",
  dolphins: "MIA", vikings: "MIN", patriots: "NE", saints: "NO", giants: "NYG",
  jets: "NYJ", eagles: "PHI", steelers: "PIT", "49ers": "SF", niners: "SF",
  seahawks: "SEA", buccaneers: "TB", bucs: "TB", titans: "TEN", commanders: "WAS" };
const dkTeam = (label) => {
  const l = String(label).toLowerCase();
  for (const nick of Object.keys(DK_NICK)) if (l.includes(nick)) return DK_NICK[nick];
  return null;
};

function dkHarvest(j) {
  const evs = new Map((j.events || []).map((e) => [String(e.id), e]));
  const byMarket = new Map();
  for (const sel of j.selections || []) {
    const k = String(sel.marketId);
    if (!byMarket.has(k)) byMarket.set(k, []);
    byMarket.get(k).push(sel);
  }
  const out = [];
  for (const mk of j.markets || []) {
    const name = String(mk.name || "");
    if (!/win/i.test(name)) continue;
    /* Matchbets, division winners and Super Bowl futures also say "win". */
    if (/matchbet|match bet|most|fewest|division|conference|super bowl|playoff|mvp/i.test(name)) continue;
    const sels = byMarket.get(String(mk.id)) || [];
    const lbl = (x) => String((x && (x.label || x.outcomeType)) || "");
    const over = sels.find((x) => /^over/i.test(lbl(x)));
    const under = sels.find((x) => /^under/i.test(lbl(x)));
    if (!over || !under) continue;
    const line = dkLine(over);
    if (!Number.isFinite(line) || line < 1 || line > 17) continue;
    const ev = evs.get(String(mk.eventId));
    const team = dkTeam([mk.participantName, mk.eventName, ev && ev.name, name]
      .filter(Boolean).join(" "));
    if (!team) continue;
    out.push({ team, line, over: dkPrice(over), under: dkPrice(under) });
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.team) ? false : (seen.add(r.team), true)));
}

/* MEASURED, run #4: the GitHub runner gets 403 from DraftKings. Not a bug in
   any of the code below - a datacenter-IP block. Sportsbooks refuse cloud IPs
   as a matter of course, and no amount of retrying or header-setting changes
   that, so this stays wired up (it works from a residential IP) but a second,
   non-sportsbook path is tried behind it.

   The reconnaissance below is deliberately dumb: fetch the page, count the NFL
   nicknames and the half-point numbers in it, and report. A source that has 32
   teams and 30-odd x.5 numbers has win totals in it and is worth writing a real
   parser for; one that does not, is not. Guessing at parsers before knowing
   which hosts even answer is how the first version of this file wasted a run.
   That reconnaissance runs as a dispatch-only step in the workflow, not here -
   it is a question being asked once, not a source being served. */
/* VegasInsider. MEASURED from the runner, run #5, alongside six other
   candidates: 200, 374KB, 32 of 32 team nicknames present, 339 half-point
   numbers, and the phrase "win total" in the body. Of everything probed it was
   the only host that both answered a datacenter IP and actually had the market
   - covers.com 404s, sportsoddshistory has no nicknames, ESPN 403s, the-odds-api
   wants a key, and actionnetwork's scoreboard is game lines, not futures.

   The page is a book-by-book grid (BetMGM, DraftKings, Caesars, Rivers), so the
   line is read from the row and the price from the first book that quotes one.
   Parsed by shape rather than by column index, for the same reason the ADP
   readers are: these pages reorder columns without warning, but a row will
   always be one team, one line between 1 and 17, and prices that look like
   American odds. */
function viRows(html) {
  const out = [];
  for (const cells of tableRows(html)) {
    const joined = cells.join(" ");
    const team = dkTeam(joined);
    if (!team) continue;
    /* The line is the half-point number in a sane range. Prices are three-digit
       American odds and are never confused for it because of the range check. */
    const nums = (joined.match(/(?<![\d.+-])\d{1,2}\.5(?![\d])/g) || []).map(Number)
      .filter((n) => n >= 1 && n <= 17);
    if (!nums.length) continue;
    const prices = (joined.match(/[+-]\d{3}(?![\d.])/g) || []).map(Number);
    out.push({ team, line: nums[0], over: prices[0] ?? null, under: prices[1] ?? null });
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.team) ? false : (seen.add(r.team), true)));
}

async function viWins() {
  const html = await get("https://www.vegasinsider.com/nfl/odds/win-totals/");
  const rows = viRows(html);
  log(`  vi: ${rows.length} teams -> `
    + rows.slice(0, 4).map((r) => `${r.team} ${r.line} (${r.over})`).join(", "));
  if (rows.length < 20) throw new Error(`only ${rows.length} teams parsed off the page`);
  return { rows, source: "VegasInsider posted win totals",
    note: `${rows.length} teams, consensus of the books listed` };
}

async function dkWins() {
  const seed = await get(DK + "/categories/1286", "json");
  const cats = seed.categories || [];
  log("  dk: " + cats.length + " categories -> "
    + (cats.map((c) => c.id + ":" + c.name).join(", ") || "(none listed)"));
  const direct = dkHarvest(seed);
  if (direct.length >= 20) return { rows: direct, source: "DraftKings season win totals" };
  const wanted = cats.filter((c) => /win|season|futures|team/i.test(String(c.name || "")));
  for (const c of wanted) {
    try {
      const rows = dkHarvest(await get(DK + "/categories/" + c.id, "json"));
      log("  dk: category " + c.id + " \"" + c.name + "\" -> " + rows.length + " teams");
      if (rows.length >= 20) return { rows, source: "DraftKings season win totals (" + c.name + ")" };
    } catch (e) { log("  dk: category " + c.id + " - " + e.message); }
  }
  throw new Error("reachable, but no category held 20+ team win totals");
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
  /* nflverse is a snapshot and lags the season; DraftKings is the live book.
     nflverse still goes first, because for a season it HAS reached it is the
     cleaner record. For a season it has not reached, the book is the only
     genuinely posted number rather than a derived one. */
  try { return await dkWins(); }
  catch (e) { log("  wins: draftkings —", e.message); }
  try { return await viWins(); }
  catch (e) { log("  wins: vegasinsider —", e.message); }
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
