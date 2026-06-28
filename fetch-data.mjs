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

// --- 1) Log in, grab the session cookie ---
const loginRes = await fetch(`${BASE}/data.php?type=loginUser`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(creds),
});
const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
if (!cookie) throw new Error("Login failed — no cookie");
console.log("✅ logged in");

const get = (type) =>
  fetch(`${BASE}/data.php?type=${type}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const post = (type, body) =>
  fetch(`${BASE}/data.php?type=${type}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// --- 2) All games (also used to decide whether anything needs updating) ---
const rawGames = await get("getEndedGames");
console.log(`✅ games: ${rawGames.length}`);

// Window helpers around kickoff. "active" = must update; "soon" = loop tight.
const now = Date.now();
const inWindow = (g, leadMin) =>
  g.beggining && now >= g.beggining - leadMin * 60_000 && now <= g.beggining + 135 * 60_000;
const active = rawGames.some((g) => inWindow(g, 5)); // live or just finished

// Always check every 5 min so the "checked" heartbeat stays fresh.
console.log(`NEXT_SLEEP=300`);

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
    date: g.fixturedata?.timing || "",
    status: g.status || "",
    kickoff: g.beggining || null,
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
