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
  return offScale(out);
}

/* "The last decimal after the name" is the right rule for a table whose columns
   move around, and it is wrong on any row where some other column happens to be
   the last decimal. It cannot be caught row by row, because one number on its
   own is never implausible — it is only implausible next to the rest of the
   table.

   Measured on the 26 Aug 2026 NFFC pull: 531 rows between 1.5 and 285, and four
   rows at 1018, 1063, 1092 and 1116. Nothing in between. The four were Dak
   Prescott, Aaron Jones, Tyjae Spears and Daniel Jones — all real players who
   sit around 84 to 200 everywhere else, published at the very bottom of the
   board. The set changes run to run, which is what makes it worth catching
   here rather than remembering a list of names.

   What distinguishes a misread column is a GAP: 283, 284, 284, 285, then 1018,
   with nothing in between. A real ADP table has no such hole, because pick
   numbers are continuous.

   Three bars were tried on that gap before one held. Twice the 99th percentile
   refused nothing, because with four bad rows in three hundred the 99th
   percentile is computed from the very rows it is meant to catch. Four times
   the median alone threw away three team defences priced correctly at 205 to
   210 on a small top-heavy feed. "Above a doubling jump AND above four times
   the median" shipped, ran, and then let Caleb Douglas through at 568 against
   a real maximum of 284.70 on the 26 Aug 2026 pull: 568 / 284.70 is 1.995,
   just under the doubling test, and NFFC's median is 259.41 because the feed
   piles hundreds of barely-drafted players just below its own maximum, so four
   times the median is 1,038 and the scan broke before it ever looked.

   The anchor that works is the feed's OWN typical spacing between consecutive
   prices. Measured across all five ADP feeds on 26 Aug 2026, the widest hole
   inside a healthy feed is 2.4 to 3.7 times that feed's 95th-percentile gap:
   FFPC 7.93 against 3.34, FFPC superflex 10.78 against 2.94, FFPC chop 7.61
   against 3.23, Best Ball superflex 8.4 against 2.91. NFFC's hole is 283.30
   against 2.14 -- 132 times. The bar is 10: three times above the worst
   healthy feed, thirteen times below the fault.

   A row is dropped when it sits past a hole of at least ten times the feed's
   typical spacing, is at least a quarter again the price below it (no healthy
   feed's top consecutive ratio exceeds 1.002), and is in the top tenth of the
   feed to begin with. A smooth tail of any length is left alone, and so is a
   short top-heavy feed. */
function offScale(rows) {
  const a = rows.map((r) => r.adp).filter((v) => v > 0).sort((x, y) => x - y);
  if (a.length < 20) return rows;
  const gaps = [];
  for (let i = 1; i < a.length; i++) gaps.push(a[i] - a[i - 1]);
  const gs = gaps.slice().sort((x, y) => x - y);
  const typical = Math.max(gs[Math.floor(0.95 * (gs.length - 1))],
    (a[a.length - 1] - a[0]) / a.length);
  const body = a[Math.floor(0.9 * (a.length - 1))];
  let cut = Infinity;
  for (let i = a.length - 1; i > 0; i--) {
    if (a[i] <= body) break;
    if (a[i] - a[i - 1] >= 10 * typical && a[i] / a[i - 1] >= 1.25) cut = a[i];
  }
  const bad = rows.filter((r) => r.adp >= cut);
  if (bad.length) log(`  dropped ${bad.length} off-scale ADP: ${bad.slice(0, 5).map((r) => `${r.name} ${r.adp}`).join(", ")}`);
  return rows.filter((r) => r.adp < cut);
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

/* Positional finishes — the data the Consistency weight has never had.

   Draft Desk multiplies a player's blend by a consistency score derived from
   where he finished AT HIS POSITION in past seasons. The weight has sat in the
   app since the beginning and has been hidden the whole time, because not one
   player of 333 had a finish history behind it: `finishes` was an empty array
   on every row and the dial did nothing.

   The obvious source was nflverse, which the win-totals job already reads. It
   is not viable and this was checked rather than assumed: the `player_stats`
   release on nflverse-data carries 1,822 assets, its newest season file is
   player_stats_season_2024.csv, its newest asset of any kind is dated
   2025-05-07, and a filter for any filename containing 2025 or 2026 returns
   nothing. The project stopped publishing before the 2025 season ended — which
   is also why `wins` fails every run and the board's Vegas axis is dark.

   FantasyPros publishes the same thing as a plain ranked table, one page per
   position per season, no key and no login: /nfl/stats/{pos}.php?year=Y&
   scoring=PPR. The Rank column IS the positional finish — RB1 is a 1 — so
   nothing is being computed here, only read. Verified 26 Aug 2026 across all
   twelve pages: QB 86/88/86 rows, RB 173/165/171, WR 262/257/237, TE 158/146/140,
   with Josh Allen QB1 in 2025 and 2023, Lamar Jackson QB1 in 2024, Puka Nacua
   WR1 in 2025 and Brock Bowers TE1 in 2024.

   Four positions, not six. Kickers and team defences are on the same pages, but
   the Consistency score is about a player holding a level year to year, which
   is the least meaningful thing you can say about a kicker, and a defence's
   name has to be matched by team rather than by string. Both are left out
   deliberately rather than half-done.

   One honest limitation, worth stating because the score cannot see it: a
   player only appears in a season's table if he played enough to be listed. A
   season missed through injury leaves no entry, so the score reads him as
   slightly more consistent than a full record would. The alternative — filling
   the gap with a made-up bottom finish — would be worse, because it would
   invent a fact. */
const FP_STATS = "https://www.fantasypros.com/nfl/stats";
const FINISH_POS = ["qb", "rb", "wr", "te"];
const FINISH_YEARS = 3;

async function finishes() {
  const years = [];
  for (let i = 1; i <= FINISH_YEARS; i++) years.push(SEASON - i);
  /* Most recent season first, so the array reads the way a person would say it.
     The score itself is order-blind — it is a mean and a spread — but the app
     shows the list. */
  const by = new Map();
  const seen = [];
  for (const y of years) {
    for (const pos of FINISH_POS) {
      const r = await fetch(`${FP_STATS}/${pos}.php?year=${y}&scoring=PPR`,
        { headers: { "user-agent": UA, accept: "text/html" } });
      if (!r.ok) throw new Error(`${pos} ${y} -> ${r.status}`);
      const rows = tableRows(await r.text());
      let n = 0;
      for (const c of rows) {
        if (c.length < 3) continue;
        const rank = /^\d+$/.test(c[0]) ? Number(c[0]) : null;
        if (!rank) continue;
        const m = String(c[1] || "").match(/^(.*?)\s*\(([A-Za-z]{2,3})\)$/);
        const name = (m ? m[1] : c[1] || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!by.has(key)) by.set(key, { name, pos: pos.toUpperCase(), finishes: [] });
        by.get(key).finishes.push(rank);
        n++;
      }
      /* A page that comes back thin is a layout change, not a quiet season.
         Every one of the twelve is at least 86 rows. */
      if (n < 30) throw new Error(`${pos} ${y}: only ${n} ranked rows parsed`);
      seen.push(`${pos}${y}:${n}`);
    }
  }
  const rows = [...by.values()];
  if (rows.length < 300) throw new Error(`only ${rows.length} players across ${seen.length} pages`);
  return { rows, source: "fantasypros.com/nfl/stats PPR season tables",
    note: `${years.join(", ")} \u00b7 ${seen.join(" ")}` };
}

/* NFFC SuperFlex, draft_type 961 — the second superflex MARKET this board has
   never had, and the honest replacement for the slot `bbsf` was faking.

   Everything else superflex on the board is either FFPC (one house, one price)
   or an analyst opinion. NFFC is a different house running real money, on the
   same endpoint the one-QB feed already uses, and its own draft-type menu names
   961 "SuperFlex". Checked 26 Aug 2026: the contest exists and has no drafts
   yet — the endpoint answers "No ADP Information Available" — so this job fails
   cleanly every run and the slot stays empty until NFFC opens superflex
   drafting. An empty slot is honest; the alternative is what bbsf was.

   Two other candidates were checked the same day and rejected on evidence.
   MyFantasyLeague's ADP export publishes a real independent market (638 drafts)
   but has no superflex filter: IS_SUPERFLEX=1, IS_SUPERFLEX=0 and a deliberately
   invented parameter all return the identical 388 rows and the identical 638
   drafts, while IS_PPR genuinely splits it 544/94 — so unknown parameters are
   silently ignored, and its QB3 sits at 26, a one-QB shape. Underdog returns
   zero appearances for the 2026 season slate and has failed every run.

   The qbShape guard is not decoration. It is the exact test bbsf failed: a
   superflex board puts the third quarterback inside the top handful, a one-QB
   board puts him in the thirties. If NFFC ever answers this draft_type with a
   one-QB board, this throws rather than publishing it under a superflex name. */
async function nffcSF() {
  const out = await nffc(NFFC_CONTESTS.superflex);
  const rows = [...out.rows].sort((a, b) => a.adp - b.adp);
  const { first, third, count } = qbShape(rows);
  if (!third || third > 12)
    throw new Error(`draft_type 961 is not superflex-shaped: `
      + `QB1 at ${first}, QB3 at ${third}, ${count} quarterbacks in ${rows.length} rows`);
  return { rows, source: "nfc.shgn.com adp.data.php draft_type 961 (NFFC SuperFlex)" };
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
/* MEASURED, run #6, and this is the bug worth remembering. Taking "the first
   two American-odds numbers in the row" got the LINE right for all 32 teams and
   the PRICES wrong for all 32: what landed in `over` was a column earlier in the
   row, and what landed in `under` was the actual over. Checked against the
   rendered page for six teams - Baltimore 11.5 reads O +120, the first pass had
   over -150 and under +120.

   Silently inverted prices are worse than no prices at all: Draft Desk de-vigs
   them into a win probability, so every team would have been pushed the wrong
   way with nothing on screen to suggest it. Prices are now read from the O and U
   LABELS beside them, paired inside one book's cell where the page puts them
   together, and the vig is checked afterwards - a de-vigged pair that does not
   sum to something between 1.00 and 1.20 means the columns have moved again. */
const priceAfter = (txt, side) => {
  const m = String(txt).match(new RegExp("\\b" + side + "\\b[^0-9+\\-]{0,4}([+-]\\d{3})", "i"));
  return m ? Number(m[1]) : null;
};
const impliedFromAmerican = (a) => (a == null ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100));

function viRows(html) {
  const out = [];
  for (const cells of tableRows(html)) {
    const joined = cells.join(" ");
    const team = dkTeam(joined);
    if (!team) continue;
    const nums = (joined.match(/(?<![\d.+-])\d{1,2}\.5(?![\d])/g) || []).map(Number)
      .filter((n) => n >= 1 && n <= 17);
    if (!nums.length) continue;
    /* Prefer one book's own cell, where the two sides sit together and cannot be
       paired across columns by accident. */
    let over = null, under = null;
    for (const c of cells) {
      const o = priceAfter(c, "O"), u = priceAfter(c, "U");
      if (o != null && u != null) { over = o; under = u; break; }
    }
    if (over == null) {
      for (const c of cells) {
        if (over == null) over = priceAfter(c, "O");
        if (under == null) under = priceAfter(c, "U");
      }
    }
    out.push({ team, line: nums[0], over, under });
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.team) ? false : (seen.add(r.team), true)));
}

/* A pair of American prices on the two sides of one line always overrounds a
   little. If they do not, they are not two sides of the same line.

   The bound is 14%, not 20%. My first attempt used 20% and it did NOT catch the
   very bug it was written for: two OVER prices from different books, -150 and
   -145, sum to 1.19 and slid straight through. Real season win totals run about
   4-7% vig - the six pairs checked against the page came in at 1.046 to 1.057 -
   so 14% is already generous headroom and 20% was not a check at all. */
const VIG_MAX = 1.14;
function vigOk(r) {
  const a = impliedFromAmerican(r.over), b = impliedFromAmerican(r.under);
  if (a == null || b == null) return false;
  const sum = a + b;
  return sum > 1.0 && sum < VIG_MAX;
}

async function viWins() {
  const html = await get("https://www.vegasinsider.com/nfl/odds/win-totals/");
  const rows = viRows(html);
  const priced = rows.filter((r) => r.over != null && r.under != null);
  const sane = priced.filter(vigOk);
  log(`  vi: ${rows.length} teams, ${priced.length} with both prices, ${sane.length} passing the vig check`);
  log(`  vi: ` + rows.slice(0, 4).map((r) => `${r.team} ${r.line} O${r.over} U${r.under}`).join(", "));
  if (rows.length < 20) throw new Error(`only ${rows.length} teams parsed off the page`);
  /* Lines without prices are still worth having - Draft Desk can use the line
     alone - so a price failure drops the prices, not the row. */
  if (priced.length >= 20 && sane.length < priced.length * 0.75) {
    log(`  vi: prices look mispaired (${sane.length}/${priced.length} sane) - publishing lines only`);
    return { rows: rows.map((r) => ({ team: r.team, line: r.line, over: null, under: null })),
      source: "VegasInsider posted win totals",
      note: `${rows.length} teams, lines only - the price columns did not check out` };
  }
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

/* ---------- FantasyPros: individual expert boards ----------

   Draft Desk's five named experts were chosen off FantasyPros' MULTI-YEAR draft
   accuracy board, and none of the multi-year top eight publish 2026 rankings to
   FantasyPros any more (Jody Smith #1 and Jared Smola #7 are Draft Sharks, which
   is paywalled; Koerner #2, Wright #3, Ratcliffe #4, Kluge #5 are absent from
   FantasyPros' current 154). The six below are the best multi-year drafters who
   ARE both listed and still updating for 2026. Ranks read off
   /nfl/accuracy/multi-year-draft.php (157 analysts) on 22 Aug 2026.

   The endpoint is the one the Pick Experts modal itself calls. Three details
   were measured from the page rather than guessed, and each one is load-bearing:

   1. The selector parameter is `filters`, not `experts`. An `experts` value is
      accepted and silently IGNORED — the response comes back as the full
      103-expert consensus. That failure is invisible without a check, so
      fpRows asserts total_experts === 1 and refuses anything else.
   2. Multiple ids are joined with a COLON. A comma falls back to full
      consensus, again silently. Single ids are what this file uses, so the
      colon is documented here rather than relied on.
   3. With one id the payload IS that expert's own board: rank_min, rank_max and
      rank_ecr are equal on every row, and `last_updated` is that expert's own
      publish date. That is what makes per-expert weighting possible — a blend
      would flatten six analysts of unequal record into one equal-weight vote,
      which is exactly the distinction the multi-year board was consulted for.

   The key is the public one embedded in FantasyPros' own page script, sent by
   every visitor's browser. No account, no login, nothing of the user's. */
const FP_API = "https://api.fantasypros.com/v2/json";
const FP_KEY = "zjxN52G3lP4fORpHRftGI2mTU8cTwxVNvkjByM3j";

const FP_EXPERTS = [
  { sid: "fpwheeler",  id: 835,  who: "Kev Wheeler",   site: "Wheel Route FF",              my: 9  },
  { sid: "fpmaher",    id: 908,  who: "Mike Maher",    site: "BettingPros",                 my: 11 },
  { sid: "fpweisse",   id: 3585, who: "Ryan Weisse",   site: "Club Fantasy FFL",            my: 12 },
  { sid: "fpciallela", id: 1667, who: "Mick Ciallela", site: "Fantrax",                     my: 14 },
  { sid: "fpwasley",   id: 2559, who: "Ben Wasley",    site: "Hashtag Football",            my: 15 },
  { sid: "fpmiller",   id: 2743, who: "Seth Miller",   site: "Crossroads Fantasy Football", my: 28 },
];

/* `position` picks the BOARD, not a filter on it. ALL is the one-QB draft
   board; OP ("offensive player") is the superflex one, where quarterbacks are
   ranked as if they were flex-eligible. They are genuinely different boards,
   not a re-sort: on the ALL board the first quarterback lands around #27, on OP
   he is #1. Measured 22 Aug 2026, and the per-expert `filters` selector works
   identically on both. */
async function fpJson(filters, position = "ALL") {
  const u = `${FP_API}/nfl/${SEASON}/consensus-rankings`
    + `?type=draft&scoring=PPR&position=${position}&week=0&sport=NFL&filters=${encodeURIComponent(filters)}`;
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json",
    "content-type": "application/json", "x-api-key": FP_KEY } });
  if (!r.ok) throw new Error(`fantasypros -> ${r.status}`);
  return r.json();
}

/* Turn one expert's payload into relay rows. Kept separate from the fetch so
   the shape checks are testable without a network. */
function fpRows(j, exp) {
  const total = Number(j && j.total_experts);
  if (total !== 1) throw new Error(`filters=${exp.id} came back as ${total || "?"} experts — the id was ignored`);
  const ids = String((j && j.filters) || "").split(",").filter(Boolean);
  if (ids.length !== 1 || ids[0] !== String(exp.id))
    throw new Error(`asked for ${exp.id}, got [${ids.join(",")}]`);
  const rows = (j.players || []).map((p) => ({
    name: String(p.player_name || "").trim(),
    /* rank IS the datum here. It is repeated into `adp` because Draft Desk's
       reader sorts on adp and numbers the result; for a single-expert board the
       two are the same number, so nothing is being fudged into an ADP. */
    adp: Number(p.rank_ecr),
    rank: Number(p.rank_ecr),
    pos: canonPos(p.player_position_id),
    team: p.player_team_id || null,
  })).filter((r) => r.name && Number.isFinite(r.adp) && r.adp > 0);
  /* An expert who has ranked 40 players is a partial board and would drag a
     weighted consensus around by absence. 150 is roughly a 12-team draft. */
  if (rows.length < 150) throw new Error(`${exp.who} has only ${rows.length} players ranked`);
  const seen = new Set(); let dup = 0;
  rows.forEach((r) => { if (seen.has(r.adp)) dup++; seen.add(r.adp); });
  if (dup > 5) throw new Error(`${exp.who}: ${dup} duplicated ranks`);
  return rows;
}

/* A superflex board has to actually BE one, and the cheap way to be sure is to
   ask where the quarterbacks are. On a one-QB board the third quarterback sits
   somewhere in the thirties; on a superflex board he is inside the top handful.
   Anything in between means the position parameter was ignored and a one-QB
   board is about to be published under a superflex name — which is exactly the
   silent-substitution failure that put a duplicate of FFPC's superflex board
   into `bbsf` and left a league reporting coverage it did not have. */
function qbShape(rows) {
  const qb = rows.map((r, i) => r.pos === "QB" ? i + 1 : 0).filter(Boolean);
  return { first: qb[0] ?? null, third: qb[2] ?? null, count: qb.length };
}

/* The full FantasyPros consensus, fetched rather than pasted.

   `fpcustom` on the board was a hand-pasted export, and the paste parser had
   been picking the wrong column: it stored a flat cell index from a ten-column
   table — 2, 12, 22, 32 … max 5790 across 338 players — instead of the rank.
   The ordering was perfect (rho 0.965 against the healthy sources) and the
   magnitudes were nonsense, which is the worst of the two combinations: a board
   that averages raw rank numbers reads only the magnitudes, so the wrong answer
   arrives looking entirely plausible. It put Justin Jefferson at 93.

   v87 makes the app immune to that by re-numbering every source before it
   blends. This removes the cause rather than merely surviving it: the same API
   the expert boards come from returns the consensus when no `filters` is given,
   already as clean integer ranks, so there is no column left to pick wrongly.

   Omitting the filter means the site's own default panel of 100-odd analysts,
   so this is a genuine consensus and NOT the six named boards counted twice —
   those are fetched separately and weighted on their own multi-year record. */
async function fpConsensus(position = "ALL") {
  const u = `${FP_API}/nfl/${SEASON}/consensus-rankings`
    + `?type=draft&scoring=PPR&position=${position}&week=0&sport=NFL`;
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json",
    "content-type": "application/json", "x-api-key": FP_KEY } });
  if (!r.ok) throw new Error(`fantasypros ecr -> ${r.status}`);
  const j = await r.json();
  const total = Number(j.total_experts);
  /* A "consensus" of one is a single analyst's board wearing the wrong name. */
  if (!(total >= 20)) throw new Error(`ecr came back as ${total || "?"} experts`);
  const rows = (j.players || []).map((pl) => ({
    name: String(pl.player_name || "").trim(),
    adp: Number(pl.rank_ecr), rank: Number(pl.rank_ecr),
    pos: canonPos(pl.player_position_id), team: pl.player_team_id || null,
  })).filter((x) => x.name && Number.isFinite(x.adp) && x.adp > 0);
  if (rows.length < 200) throw new Error(`only ${rows.length} players in the consensus`);
  /* The bug this replaces, asserted against directly: ranks have to be dense
     and start at 1, not a stride-10 cell index climbing into the thousands. */
  const sorted = rows.map((x) => x.rank).sort((a, b) => a - b);
  if (sorted[0] !== 1) throw new Error(`ranks start at ${sorted[0]}, not 1`);
  if (sorted[sorted.length - 1] > rows.length * 1.5)
    throw new Error(`ranks run to ${sorted[sorted.length - 1]} for ${rows.length} players — that is not a rank column`);
  const q = qbShape(rows);
  const sf = position === "OP";
  if (sf && !(q.third <= 12)) throw new Error(`asked for superflex ecr, got QB3 at #${q.third}`);
  if (!sf && !(q.third > 12)) throw new Error(`asked for one-QB ecr, got QB3 at #${q.third}`);
  return { rows, source: `fantasypros consensus ECR${sf ? " — superflex" : ""} (${total} analysts)`,
    note: `${total} analysts; QB3 at #${q.third}; updated ${j.last_updated || "?"}`,
    expert: { who: "FantasyPros consensus", analysts: total, superflex: sf,
      updated: j.last_updated || null } };
}

async function fpExpert(exp, position = "ALL") {
  const sf = position === "OP";
  const j = await fpJson(String(exp.id), position);
  const rows = fpRows(j, exp);
  const q = qbShape(rows);
  if (q.third == null) throw new Error(`${exp.who}: fewer than three quarterbacks ranked`);
  if (sf && q.third > 12)
    throw new Error(`${exp.who}: asked for superflex, got a board with QB3 at #${q.third}`);
  if (!sf && q.third < 12)
    throw new Error(`${exp.who}: asked for one-QB, got a board with QB3 at #${q.third}`);
  return { rows,
    source: `fantasypros — ${exp.who} (${exp.site})${sf ? " — superflex" : ""}`,
    note: `individual ${sf ? "superflex " : ""}draft board; multi-year draft accuracy #${exp.my} of 157; QB3 at #${q.third}; expert updated ${j.last_updated || "?"}`,
    expert: { id: exp.id, who: exp.who, site: exp.site, multiYearRank: exp.my,
      updated: j.last_updated || null, superflex: sf, qb3: q.third } };
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
  ["nffcsf", nffcSF],
  ["finishes", finishes],
  ["ffpc", () => ffpc("ffpc", FFPC.mainEvent)],
  ["ffpcchop", () => ffpc("ffpcchop", FFPC.chop)],
  ["ffpcsf", () => ffpc("ffpcsf", FFPC.sfBbt)],
  /* bbsf is gone, and it was a bug rather than a source.

     It was pulling FFPC.sfBbt — the exact same contest `ffpcsf` above pulls —
     and publishing it under a second name. Downstream, Draft Desk read the two
     files as two independent superflex markets and gave them a combined weight
     of 2.6, so one market voted twice and a league that had one superflex board
     was reported as having two. Measured 22 Aug 2026: identical `source`
     string, 340 of 364 rows byte-identical, rank correlation 1.000 over all
     364 players.

     The slot it fed still exists in the app, switched off, waiting for a book
     that is genuinely not FFPC — DraftKings Best Ball superflex or Underdog SF.
     Publishing a clone into it was worse than leaving it empty, because an
     empty slot shows up in the coverage matrix and a clone does not. */
  ["fpproj", fpProjections],
  ["wins", wins],
  ...FP_EXPERTS.map((e) => [e.sid, () => fpExpert(e, "ALL")]),
  /* The same six analysts, superflex. Red Wing is best ball AND superflex, and
     until now the only superflex opinion on the board was FFPC's — one market,
     which `bbsf` was quietly duplicating to look like two. These are six
     genuinely separate superflex boards, and they disagree: Weisse has
     Allen/Maye/Burrow at the top, Wheeler has Allen/Jackson/Maye. */
  ...FP_EXPERTS.map((e) => [e.sid + "sf", () => fpExpert(e, "OP")]),
  /* Replaces the hand-pasted fpcustom export, and the wrong-column parse with
     it. Same endpoint, no filter, so no column to misread. */
  ["fpcustom", () => fpConsensus("ALL")],
  ["fpcustomsf", () => fpConsensus("OP")],
];

let ok = 0, failed = [];
for (const [name, fn] of JOBS) {
  try {
    const got = await fn();
    const extra = {};
    if (got.tournament) extra.tournament = got.tournament;
    if (got.expert) extra.expert = got.expert;
    await publish(name, got.rows, got.source, got.note, extra);
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
/* FantasyPros projections — the second projection set, relayed.

   The two projection sets that decide this board were hand-pasted, and a
   projection is the one thing where staleness is invisible: a week-old rank
   still looks like a rank, and a week-old point total still looks like points.
   This puts one of them on the same twice-daily clock as everything else.

   STAT LINES, not points. A finished point total is frozen at whatever scoring
   it was computed under; Draft Desk detects that and refuses the source in any
   league whose rules do not match. A stat line re-scores itself for all
   seventeen. That is why this reads the per-stat columns and never `points`.

   One call per position because the endpoint is per position, merged on name.
   Validated the same way every other job here is: enough rows, a real spread of
   positions, and yardage that looks like yardage — a season projection that
   thinks the best receiver gains 90 yards has failed, and failing loudly is
   the whole point of these checks. */

async function fpProjections() {
  const FP_PROJ_POS = ["QB", "RB", "WR", "TE"];
  const FP_PROJ_KEYS = { pass_yds: "passYds", pass_tds: "passTD", pass_ints: "ints", pass_int: "ints", rush_yds: "rushYds", rush_tds: "rushTD", rec: "rec", receptions: "rec", rec_yds: "recYds", rec_tds: "recTD" };
  const byName = new Map();
  const seen = [];
  for (const pos of FP_PROJ_POS) {
    const u = `${FP_API}/nfl/${SEASON}/projections`
      + `?position=${pos}&scoring=PPR&week=draft&sport=NFL`;
    const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json",
      "content-type": "application/json", "x-api-key": FP_KEY } });
    if (!r.ok) throw new Error(`fantasypros projections ${pos} -> ${r.status}`);
    const j = await r.json();
    const list = j.players || j.data || [];
    if (!Array.isArray(list) || !list.length) throw new Error(`${pos}: no players in the payload`);
    let took = 0;
    for (const pl of list) {
      const name = String(pl.player_name || pl.name || "").trim();
      if (!name) continue;
      const src = pl.stats && typeof pl.stats === "object" ? pl.stats : pl;
      const stats = {};
      for (const [k, v] of Object.entries(FP_PROJ_KEYS)) {
        const n = Number(src[k]);
        if (Number.isFinite(n)) stats[v] = n;
      }
      if (!Object.keys(stats).length) continue;
      byName.set(name, { name, pos: canonPos(pl.player_position_id || pos),
        team: pl.player_team_id || null, stats });
      took++;
    }
    seen.push(`${pos} ${took}`);
    if (!took) throw new Error(`${pos}: no row carried a stat column — the keys have moved`);
  }

  const rows = [...byName.values()];
  if (rows.length < 200) throw new Error(`only ${rows.length} players across four positions`);

  /* The numbers have to look like a season, not a week. A projection set that
     arrives as per-game averages would blend silently and read 17x light. */
  const topWr = rows.filter((x) => x.pos === "WR").map((x) => x.stats.recYds || 0)
    .sort((a, b) => b - a)[0] || 0;
  if (topWr < 700) throw new Error(`best receiver projects ${Math.round(topWr)} yards — that is not a season`);
  const topQb = rows.filter((x) => x.pos === "QB").map((x) => x.stats.passYds || 0)
    .sort((a, b) => b - a)[0] || 0;
  if (topQb < 2500) throw new Error(`best passer projects ${Math.round(topQb)} yards — that is not a season`);

  /* Touchdown columns are the import failure that costs the most and shows the
     least, so their absence is stated rather than discovered downstream. */
  const noTd = rows.filter((x) => x.stats.rushTD == null && x.stats.recTD == null
    && x.stats.passTD == null).length;

  return { rows,
    source: "fantasypros projections (PPR, draft week)",
    note: `${rows.length} players — ${seen.join(", ")}${noTd ? ` · ${noTd} rows carry no touchdown column` : ""}` };
}
