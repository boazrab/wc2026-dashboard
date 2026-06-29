// The data engine: logs in, pulls roster + all games + everyone's bets per game,
// and writes one clean file the dashboard reads: data/dashboard.json
//
// Credentials come from env vars (SPORT5_EMAIL / SPORT5_PASSWORD) in the cloud,
// or from a local secrets.json when running on your machine.
// By default it SKIPS fetching when no game is live/recent (saves load); pass
// --force (or FORCE=1) to always fetch — used for on-demand "update now".
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://hevre.sport5.co.il/server";
const GROUP_ID = "6a24a5fc8b3581042d06f562";
const FORCE = process.argv.includes("--force") || process.env.FORCE === "1";

const creds = process.env.SPORT5_EMAIL
  ? { email: process.env.SPORT5_EMAIL, password: process.env.SPORT5_PASSWORD }
  : JSON.parse(readFileSync("./secrets.json", "utf8"));

const num = (v) => (v === "" || v == null ? null : Number(v));

// --- 1) Log in, grab the session cookie (retry — sport5 occasionally blips) ---
async function login() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/data.php?type=loginUser`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds),
      });
      const c = (res.headers.get("set-cookie") || "").split(";")[0];
      if (c) return c;
      console.log(`login attempt ${attempt}: no cookie, retrying…`);
    } catch (e) {
      console.log(`login attempt ${attempt} failed (${e.message}), retrying…`);
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error("Login failed after 4 attempts — no cookie");
}
const cookie = await login();
console.log("✅ logged in");

// every sport5 call retries a few times so a transient blip never crashes the run
async function reqJSON(url, opts, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, opts);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((res) => setTimeout(res, i * 1000));
    }
  }
}
const get = (type) => reqJSON(`${BASE}/data.php?type=${type}`, { headers: { Cookie: cookie } });
const post = (type, body) =>
  reqJSON(`${BASE}/data.php?type=${type}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

// --- 2) All games (also used to decide whether anything needs updating) ---
const rawGames = await get("getEndedGames");
if (!Array.isArray(rawGames)) throw new Error("getEndedGames did not return a list — bad response");
console.log(`✅ games: ${rawGames.length}`);

// Decide if any game still needs pulling. Rather than assume a fixed game length (breaks for
// knockout extra-time + penalties), we treat a game as LIVE until sport5 stops touching it:
//   - from 15 min before kickoff, AND
//   - while sport5 is still updating it (lastUpdate within the last 40 min), OR within a generous
//     6h safety floor after kickoff (covers ET + pens + settle lag even if lastUpdate is quiet).
const now = Date.now(), nowSec = now / 1000;
const active = rawGames.some((g) => {
  if (!g.beggining || now < g.beggining - 15 * 60_000) return false;
  const within6h = now <= g.beggining + 6 * 3600_000;
  const stillTouched = g.lastUpdate && nowSec - g.lastUpdate < 40 * 60;
  return within6h || stillTouched;
});

// Cadence: normally every 5 min (keeps the heartbeat fresh). But when a new game is about to
// kick off, wake ~45s AFTER kickoff so the freshly-locked bets show up almost immediately —
// the "everyone refresh at once" moment.
const nextKick = rawGames.map((g) => g.beggining).filter((t) => t && t > now).sort((a, b) => a - b)[0];
let nextSleep = 300;
if (nextKick) {
  const until = (nextKick - now) / 1000;
  if (until > 0 && until < 9 * 60) nextSleep = Math.max(20, Math.round(until + 45));
}
console.log(`NEXT_SLEEP=${nextSleep}`);

// Heartbeat: lets the site show "checked X ago" even when nothing changed.
mkdirSync("./data", { recursive: true });
writeFileSync("./data/status.json", JSON.stringify({ checkedAt: new Date().toISOString(), live: active }));

if (!active && !FORCE) {
  console.log("⏸  no live/recent games — heartbeat only, skipping data pull");
  process.exit(0);
}

// --- 3) Roster (names, total points, season picks) ---
const group = await fetch(`${BASE}/api/getGroup/${GROUP_ID}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const members = (group.members || []).map((m) => ({
  id: m._id,
  name: m.name,
  points: m.points ?? 0,
  pointsFromGuesses: m.pointsFromGuesses ?? 0,
  pointsFromScorer: m.pointsFromScrorer ?? 0,
  pointsFromChampion: m.pointsFromChampion ?? 0,
  champion: m.champion ? { name: m.champion.name, img: m.champion.img } : null,
  scorer: m.scorer ? { name: m.scorer.name, img: m.scorer.img } : null,
}));
console.log(`✅ roster: ${members.length} friends`);

// --- 4) Everyone's bets for each game (limited concurrency to be polite) ---
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

const games = await mapLimit(rawGames, 8, async (g) => {
  const res = await post("getCurrentGameGroupPoints", { gid: g.gid, groupid: GROUP_ID });
  const bets = (res.members || []).map((b) => ({
    id: b.id,
    name: b.name,
    g1: num(b.currentGame?.team1guess),
    g2: num(b.currentGame?.team2guess),
    score: b.currentGame?.gameScore ?? 0,
  }));
  return {
    gid: g.gid,
    round: g.fixturedata?.name || "",
    roundId: g.fid ?? g.fixturedata?.fid ?? null, // top-level fid is reliable even when fixturedata errors out
    date: g.fixturedata?.timing || "",
    status: g.status || "",
    kickoff: g.beggining || null,
    lastUpdate: g.lastUpdate || null,      // sport5's "last touched" time — used to tell if a game is still live
    team1: { name: g.team1?.name, img: g.team1?.img },
    team2: { name: g.team2?.name, img: g.team2?.img },
    result1: num(g.result1),
    result2: num(g.result2),
    odds: { home: num(g.ratio1), away: num(g.ratio2), draw: num(g.ratio3) }, // sport5 order: 1 / 2 / X
    scoring: { bonusExact: g.fixturedata?.bonusExact ?? null, multiplier: g.fixturedata?.pointsMultplyer ?? 1 },
    bets,
  };
});
console.log("✅ all per-game bets pulled");

// --- 5) Save ---
mkdirSync("./data", { recursive: true });
const out = { generatedAt: new Date().toISOString(), group: { name: group.name, membersCount: members.length }, members, games };
writeFileSync("./data/dashboard.json", JSON.stringify(out));
const playedCount = games.filter((g) => g.result1 != null).length;
console.log(`🎉 wrote data/dashboard.json — ${members.length} friends, ${games.length} games (${playedCount} played)`);
