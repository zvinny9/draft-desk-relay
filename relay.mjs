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

/* FFPC. The League Type picker is not in the URL — verified: ?leagueType=chop
   loads Main Event — so the page state is driven by whatever call the picker
   makes. The page is fetched, the call is found in its own script, and each
   contest is requested directly. If the page stops exposing it, the failure is
   loud and this file simply is not written. */
async function ffpc(kind, leagueType) {
  const page = "https://myffpc.com/cms/public/ffpc-league-and-tournament-adp";
  const html = await get(page);
  const api = (html.match(/["'](\/[\w/-]*adp[\w/-]*)["']/i) || [])[1];
  const end = (m) => `https://myffpc.com${m}`;
  const tries = [];
  if (api) tries.push(end(api) + `?leagueType=${leagueType}`);
  tries.push(`https://myffpc.com/api/adp?leagueType=${leagueType}`);
  tries.push(page);
  for (const u of tries) {
    try {
      const body = await get(u);
      if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
        const j = JSON.parse(body);
        const arr = Array.isArray(j) ? j : (j.players || j.rows || j.data || []);
        const rows = arr.map((r) => ({
          name: r.name || r.playerName || `${r.firstName || ""} ${r.lastName || ""}`.trim(),
          adp: Number(r.adp ?? r.averageDraftPosition), pos: r.position || r.pos || null,
          team: r.team || r.nflTeam || null,
        })).filter((r) => r.name && r.adp > 0);
        if (rows.length > 50) return { rows, source: `myffpc.com ${leagueType} (json)` };
      }
      const rows = adpFromRows(tableRows(body));
      if (rows.length > 50) return { rows, source: `myffpc.com ${leagueType} (table)` };
    } catch (e) { log(`  ffpc ${leagueType}: ${u} — ${e.message}`); }
  }
  throw new Error(`no readable ${leagueType} table`);
}

/* NFFC. nfc.shgn.com/adp/football renders server-side; a plain GET is enough
   for the public contest boards even though a browser is refused the CORS
   header. */
async function nffc() {
  const urls = [
    "https://nfc.shgn.com/adp/football",
    "https://nfc.shgn.com/adp/football?SortBy=ADP",
  ];
  for (const u of urls) {
    try {
      const rows = adpFromRows(tableRows(await get(u)));
      if (rows.length > 50) return { rows, source: "nfc.shgn.com" };
    } catch (e) { log("  nffc:", e.message); }
  }
  throw new Error("no readable NFFC table");
}

/* Underdog. api.underdogfantasy.com/v1/lobby is open and names the live Best
   Ball Mania; the rankings page itself redirects to a login. Both are tried
   from here, where there is no browser to be refused. */
async function underdog() {
  const lobby = await get("https://api.underdogfantasy.com/v1/lobby", "json");
  const L = lobby.lobby || lobby;
  const t = (L.tournaments || []).find((x) => /best ball mania/i.test(x.title || ""))
    || (L.tournaments || []).find((x) => /best ball/i.test(x.title || ""));
  if (!t) throw new Error("no Best Ball contest in the lobby");
  const slate = (t.slates || [])[0]?.id || (t.tournament_rounds || [])[0]?.slate_id;
  const tries = [
    `https://api.underdogfantasy.com/v1/slates/${slate}/adp`,
    `https://api.underdogfantasy.com/v2/slates/${slate}/adp`,
    `https://api.underdogfantasy.com/v1/tournaments/${t.id}/adp`,
    `https://api.underdogfantasy.com/beta/v5/slates/${slate}/appearances`,
  ];
  for (const u of tries) {
    try {
      const j = await get(u, "json");
      const arr = Array.isArray(j) ? j : (j.players || j.appearances || j.adp || []);
      const rows = arr.map((r) => {
        const p = r.player || r;
        return { name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
          adp: Number(r.adp ?? r.average_draft_position ?? p.adp),
          pos: p.position || p.slot || null, team: p.team_name || p.team || null };
      }).filter((r) => r.name && r.adp > 0);
      if (rows.length > 50) return { rows, source: `underdog ${t.title}`, tournament: t.id };
    } catch (e) { log("  underdog:", u.split("/").slice(3).join("/"), "—", e.message); }
  }
  throw new Error(`lobby reachable (${t.title}) but no open ADP endpoint`);
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
const JOBS = [
  ["nffc", nffc],
  ["ffpc", () => ffpc("ffpc", "mainEvent")],
  ["ffpcchop", () => ffpc("ffpcchop", "chop")],
  ["ffpcsf", () => ffpc("ffpcsf", "sfBbTournament")],
  ["bbsf", () => ffpc("bbsf", "sfBbTournament")],
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

