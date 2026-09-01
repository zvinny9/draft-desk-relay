// FantasyPros auction values - the one kind of market number this board
// has never had.
//
// Value over replacement fixes the ORDER and says nothing about the LEVEL.
// The level depends on how much of a room's money never reaches a player
// worth more than replacement at all - bench, handcuffs, third quarterbacks.
// With no auction market to check against, that sat on an assumption nobody
// could see, and the assumption was wrong by about sixty per cent.
//
// The calculator page on the site is JavaScript and useless to a script. The
// endpoint behind it is not: plain server-rendered HTML whose every row
// carries the dollar figure as an attribute. Read off the attribute rather
// than the cell text, because the cell prints the value twice.
//
// Pulled at four league sizes, because the level is a function of room size
// and a sheet for the wrong one is worse than no sheet. Every row records the
// size it came from so the app can take the one that matches its league.
//
// In its own file so a new source whose page shape may move can be reviewed
// and reverted without touching the twenty jobs that already work.

export async function fpAav() {
const SIZES = [8, 10, 12, 14];
const BUDGET = 200;
const seen = new Map();
const per = [];
for (const teams of SIZES) {
const url = "https://draftwizard.fantasypros.com/auction/fp_nfl.jsp"
+ "?sport=nfl&scoring=PPR&teams=" + teams + "&tb=" + BUDGET;
const res = await fetch(url, { headers: {
// The site serves a different, empty page to an unrecognised client, which is
  // how the first run failed: zero rows at every size. It wants to look like a
  // browser, so it gets the same user-agent the rest of this relay uses.
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  "accept": "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
} });
if (!res.ok) throw new Error("fpaav " + teams + "-team: HTTP " + res.status);
const html = await res.text();
let n = 0;
const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
let m;
while ((m = trRe.exec(html))) {
const av = /(?:^|\s)v="(-?\d+(?:\.\d+)?)"/.exec(m[1]);
if (!av) continue;
const text = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const nm = /([A-Za-z.'\- ]+?)\s*\(\s*([A-Z]{2,4})\s*-\s*([A-Z]{1,3})\s*\)/.exec(text);
if (!nm) continue;
// The rank cell ("1.") shares the text run and a full stop is a legal
// name character, so it rides along unless it is stripped.
const name = nm[1].replace(/^[^A-Za-z]+/, "").trim();
if (name.length < 3) continue;
const key = teams + "|" + name.toLowerCase();
if (seen.has(key)) continue;
seen.set(key, 1);
per.push({ name, pos: nm[3], team: nm[2], teams, value: Number(av[1]) });
n++;
}
if (n < 200) throw new Error("fpaav " + teams + "-team: only " + n + " rows - the page shape has moved");
}

// The numbers have to look like an auction, not like a ranking that happens
// to be numeric. The strongest check is that a correct sheet allocates the
// whole room: measured at ten teams it comes to $1,985 of $2,000, so a
// three-quarters floor catches a broken parse without tripping on rounding.
for (const teams of SIZES) {
const rows = per.filter((r) => r.teams === teams);
const top = Math.max(...rows.map((r) => r.value));
if (!(top >= 25 && top <= 120))
throw new Error("fpaav " + teams + "-team: top value $" + top + " is not a $" + BUDGET + " auction");
const spend = rows.reduce((a, r) => a + Math.max(0, r.value), 0);
if (spend < teams * BUDGET * 0.75)
throw new Error("fpaav " + teams + "-team: values total $" + Math.round(spend)
+ " against the $" + teams * BUDGET + " in the room - the parse has lost rows");
for (const p of ["QB", "RB", "WR", "TE"])
if (!rows.some((r) => r.pos === p)) throw new Error("fpaav " + teams + "-team: no " + p + " rows");
}

const note = SIZES.map((t) => {
const rows = per.filter((r) => r.teams === t);
return t + "tm " + rows.length + " (top $" + Math.max(...rows.map((r) => r.value)) + ")";
}).join(", ");
return {
source: "draftwizard.fantasypros.com auction calculator, PPR, $" + BUDGET,
note,
rows: per,
};
}
