// Reads data/dashboard.json and renders the two views.
const IMG_BASE = "https://hevre.sport5.co.il/";
const MY_NAME = "Boaz Rabinovitz"; // highlight my own row

let DATA = null;
let gameIndex = 0;     // scoreboard: which game is shown
let roundIdx = 0;      // leaderboard: which round is shown
let scoreFilter = null; // scoreboard: only show people who bet this scoreline
let sbSort = "gpts";    // scoreboard sort: "gpts" (points this game) or "pos" (overall position)
let STATUS = null;      // heartbeat from the updater
let firstLoad = true;
let statMgrId = null;   // which manager the Stats tab is showing

const $ = (sel) => document.querySelector(sel);
const img = (path) => (path ? IMG_BASE + path : "");
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const lastName = (n) => (n || "").trim().split(/\s+/).pop();

// Top-scorer picks → English (small fixed pool of players)
const SCORER_EN = {
  "מיקל אוירסבאל": "Oyarzabal",
  "ליאו מסי": "Messi",
  "ארלינג הלאנד": "Haaland",
  "קיליאן אמבפה": "Mbappe",
  "הארי קיין": "Kane",
  "עוסמן דמבלה": "Dembele",
  "ג'מאל מוסיאלה": "Musiala",
  "מייקל אוליסה": "Olise",
  "חוליאן אלבארס": "Alvarez",
  "ראפיניה": "Raphinha",
  "ויניסיוס ג'וניור": "Vinicius Jr",
};
const scorerName = (s) => (s ? SCORER_EN[s.name] || lastName(s.name) : "—");

// Israeli-style "updated" label: today / yesterday / DD/MM/YYYY, 24h time, no am/pm
function fmtUpdated(iso) {
  const d = new Date(iso), now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${time}`;
}

// a specific game's kickoff, Israeli style: DD/MM/YYYY HH:MM
function fmtDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// live / ended / upcoming, inferred from kickoff (the API's status field is useless)
function gameStatus(g) {
  if (!g.kickoff) return g.result1 != null ? "ended" : "upcoming";
  const now = Date.now();
  if (now < g.kickoff) return "upcoming";
  if (now <= g.kickoff + 125 * 60 * 1000) return "live"; // ~game length; dot clears just after full-time
  return "ended";
}

// colour class for a bet, kept CONSISTENT with sport5's points (which are odds-based,
// and provisional while a game is live): exact = matches score, direction = earned points
// but not exact, wrong = zero points.
function betClass(score, g1, g2, r1, r2) {
  if (r1 == null || g1 == null) return "wrong";
  if (g1 === r1 && g2 === r2) return "exact";
  return score > 0 ? "direction" : "wrong";
}

const fetchJSON = async (path) => (await fetch(`${path}?t=${Date.now()}`)).json(); // cache-bust for freshness

function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// derive the lookups the views need from the raw data
function prepare() {
  DATA.games.forEach((g) => { g._byId = {}; g.bets.forEach((b) => { g._byId[b.id] = b; }); });
  DATA.rounds = [];
  const seen = new Map();
  DATA.games.forEach((g, i) => {
    if (!seen.has(g.round)) { seen.set(g.round, DATA.rounds.length); DATA.rounds.push({ name: g.round, idxs: [] }); }
    DATA.rounds[seen.get(g.round)].idxs.push(i);
  });
  DATA.ranked = [...DATA.members].sort((a, b) => b.points - a.points);
  DATA.rankById = {};
  DATA.ranked.forEach((m, i) => { DATA.rankById[m.id] = i + 1; });
}

function updateSubtitle() {
  const checked = STATUS?.checkedAt ? ` · checked ${ago(STATUS.checkedAt)}` : "";
  $("#subtitle").textContent = `${DATA.group.name} · ${DATA.members.length} players · updated ${fmtUpdated(DATA.generatedAt)}${checked}`;
}

// Pull latest data + heartbeat. Re-render only when the data actually changed (so we don't
// disrupt your scrolling/sorting). Runs on load and every 60s.
async function refresh() {
  let fresh;
  try { fresh = await fetchJSON("./data/dashboard.json"); } catch { return; }
  try { STATUS = await fetchJSON("./data/status.json"); } catch {}

  if (firstLoad || !DATA || fresh.generatedAt !== DATA.generatedAt) {
    DATA = fresh;
    prepare();
    if (firstLoad) {
      roundIdx = DATA.rounds.length - 1;
      const lastPlayed = DATA.games.map((g, i) => (g.result1 != null ? i : -1)).filter((i) => i >= 0).pop();
      gameIndex = lastPlayed ?? DATA.games.length - 1;
      statMgrId = (DATA.members.find((m) => m.name === MY_NAME) || DATA.ranked[0]).id; // default = me
      firstLoad = false;
    } else {
      roundIdx = Math.min(roundIdx, DATA.rounds.length - 1);
      gameIndex = Math.min(gameIndex, DATA.games.length - 1);
      if (!DATA.members.some((m) => m.id === statMgrId)) statMgrId = DATA.ranked[0].id;
    }
    buildGamePicker();
    buildMgrPicker();
    const sl = $("#lbWrap")?.scrollLeft || 0, sy = window.scrollY; // preserve scroll across re-render
    renderLeaderboard();
    renderScoreboard();
    renderStats();
    if ($("#lbWrap")) $("#lbWrap").scrollLeft = sl;
    window.scrollTo(0, sy);
  }
  updateSubtitle();
}

/* ---------- Leaderboard (grid: people × one round's games) ---------- */
function renderLeaderboard() {
  const q = $("#lbSearch").value.trim().toLowerCase();
  const rows = [...DATA.members]
    .sort((a, b) => b.points - a.points)
    .map((m, i) => ({ ...m, rank: i + 1 }))
    .filter((m) => !q || m.name.toLowerCase().includes(q));
  $("#lbCount").textContent = `${rows.length} of ${DATA.members.length}`;

  const round = DATA.rounds[roundIdx];
  const games = round.idxs.map((i) => DATA.games[i]).reverse(); // newest game first (next to names)
  $("#roundLabel").textContent = round.name;
  $("#roundNewer").disabled = roundIdx >= DATA.rounds.length - 1;
  $("#roundOlder").disabled = roundIdx <= 0;

  const head = `<thead><tr>
    <th class="freeze f-champ" title="Champion pick">🏆</th>
    <th class="freeze f-scorer" title="Top scorer pick">⚽</th>
    <th class="freeze f-rank">#</th>
    <th class="freeze f-name">NAME</th>
    <th class="freeze f-pts" title="Total points">PTS</th>
    ${games
      .map((g) => {
        const sc = g.result1 != null ? `${g.result1}-${g.result2}` : "vs";
        const tip = `${g.team1.name} ${sc} ${g.team2.name} — ${g.round}`;
        const live = gameStatus(g) === "live" ? `<span class="live-dot" title="Live — points are provisional"></span>` : "";
        return `<th class="game" data-gi="${DATA.games.indexOf(g)}" title="${esc(tip)} (click → Scoreboard)">
          <div class="gh">${live}<img src="${img(g.team1.img)}" loading="lazy" alt=""><span class="gsc">${sc}</span><img src="${img(g.team2.img)}" loading="lazy" alt=""></div>
        </th>`;
      })
      .join("")}
    <th class="rtot" title="Points this round">ROUND</th>
  </tr></thead>`;

  const body = `<tbody>${rows
    .map((m) => {
      const me = m.name === MY_NAME ? "row-me" : "";
      const top = m.rank === 1 ? "top1" : "";
      const champ = m.champion ? `<img class="cflag" src="${img(m.champion.img)}" title="${esc(m.champion.name)}" loading="lazy" alt="">` : "";
      const scorer = `<span title="${esc(m.scorer?.name || "")}">${esc(scorerName(m.scorer))}</span>`;
      let roundPts = 0;
      const cells = games
        .map((g) => {
          const b = g._byId[m.id];
          const v = betClass(b?.score ?? 0, b?.g1, b?.g2, g.result1, g.result2);
          const txt = b && b.g1 != null ? `${b.g1}-${b.g2}` : "—";
          const pts = b ? b.score ?? 0 : 0;
          roundPts += pts;
          return `<td class="gcell"><span class="bet ${v}">${txt}</span><span class="gp">${pts} pts</span></td>`;
        })
        .join("");
      return `<tr class="${me} ${top}">
        <td class="freeze f-champ">${champ}</td>
        <td class="freeze f-scorer">${scorer}</td>
        <td class="freeze f-rank">${m.rank}</td>
        <td class="freeze f-name"><span class="name" dir="auto">${esc(m.name)}</span></td>
        <td class="freeze f-pts pts">${m.points}</td>
        ${cells}
        <td class="rtot">${roundPts}</td>
      </tr>`;
    })
    .join("")}</tbody>`;

  $("#lbWrap").innerHTML = `<table class="grid matrix-table">${head}${body}</table>`;
}

/* ---------- Scoreboard ---------- */
function buildGamePicker() {
  $("#gamePick").innerHTML = DATA.games
    .map((g, i) => {
      const sc = g.result1 != null ? `${g.result1}-${g.result2}` : "vs";
      return `<option value="${i}">${esc(g.team1.name)} ${sc} ${esc(g.team2.name)} — ${esc(g.round)}</option>`;
    })
    .join("");
}

function renderScoreboard() {
  const g = DATA.games[gameIndex];
  $("#gamePick").value = gameIndex;
  const score = g.result1 != null ? `${g.result1} - ${g.result2}` : "vs";
  $("#gameCard").innerHTML = `
    <div class="score-line">
      <div class="team t1"><span dir="auto">${esc(g.team1.name)}</span><img src="${img(g.team1.img)}" alt=""></div>
      <div class="score">${score}</div>
      <div class="team t2"><img src="${img(g.team2.img)}" alt=""><span dir="auto">${esc(g.team2.name)}</span></div>
    </div>
    <div class="game-meta">
      <span class="odd">1 <b>${g.odds.home ?? "-"}</b></span>
      <span class="odd">X <b>${g.odds.draw ?? "-"}</b></span>
      <span class="odd">2 <b>${g.odds.away ?? "-"}</b></span>
    </div>
    <div class="game-round">${esc(g.round)} · ${fmtDateTime(g.kickoff)}</div>`;

  renderDist(g);
  renderNeighbors(g);

  // filter tag
  const tag = $("#sbFilter");
  if (scoreFilter) { tag.hidden = false; tag.innerHTML = `showing <b>${scoreFilter}</b> ✕`; }
  else tag.hidden = true;

  const q = $("#sbSearch").value.trim().toLowerCase();
  let bets = g.bets
    .filter((b) => !q || (b.name || "").toLowerCase().includes(q))
    .filter((b) => !scoreFilter || (b.g1 != null && `${b.g1}-${b.g2}` === scoreFilter));
  bets = [...bets].sort(sbSort === "pos"
    ? (a, b) => (DATA.rankById[a.id] || 999) - (DATA.rankById[b.id] || 999)
    : (a, b) => (b.score ?? 0) - (a.score ?? 0));

  // show which column is the active sort
  document.querySelectorAll("#scoreboard th.sortable").forEach((th) => {
    const base = th.dataset.sort === "pos" ? "Pos" : "Pts";
    th.textContent = base + (sbSort === th.dataset.sort ? " ▾" : "");
  });

  $("#sbBody").innerHTML = bets
    .map((b) => {
      const v = betClass(b.score ?? 0, b.g1, b.g2, g.result1, g.result2);
      const me = b.name === MY_NAME ? "row-me" : "";
      const betTxt = b.g1 == null ? "—" : `${b.g1}-${b.g2}`;
      return `<tr class="${me}">
        <td class="rank">${DATA.rankById[b.id] ?? "—"}</td>
        <td><span class="name" dir="auto">${esc(b.name)}</span></td>
        <td class="num"><span class="bet ${v}">${betTxt}</span></td>
        <td class="num pts">${b.score ?? 0}</td>
      </tr>`;
    })
    .join("");
}

// "how many people bet each scoreline" — also acts as the filter
function renderDist(g) {
  // game header (so screenshots are self-explanatory)
  const st = gameStatus(g);
  const score = g.result1 != null ? `${g.result1}-${g.result2}` : "";
  const statusHtml =
    st === "live" ? `<span class="live-badge">● LIVE</span> <b>${score}</b>`
    : st === "ended" ? `Final score <b>${score}</b>`
    : "Upcoming";
  $("#sbDistGame").innerHTML =
    `<div class="dg-teams"><span dir="auto">${esc(g.team1.name)}</span> <span class="vs">vs</span> <span dir="auto">${esc(g.team2.name)}</span></div>
     <div class="dg-status">${statusHtml}</div>`;

  const counts = {};
  g.bets.forEach((b) => { if (b.g1 != null) { const k = `${b.g1}-${b.g2}`; if (!counts[k]) counts[k] = { n: 0, score: b.score ?? 0 }; counts[k].n++; } });
  const entries = Object.entries(counts).sort((a, b) => b[1].n - a[1].n);
  const max = entries.length ? entries[0][1].n : 1;
  $("#sbDist").innerHTML = entries
    .map(([sc, info]) => {
      const [a, b2] = sc.split("-").map(Number);
      const v = betClass(info.score, a, b2, g.result1, g.result2);
      const cnt = info.n;
      const active = scoreFilter === sc ? "active" : "";
      const w = Math.round((cnt / max) * 100);
      return `<button class="distrow ${active}" data-score="${sc}">
        <span class="bet ${v}">${sc}</span>
        <span class="bar"><span class="barfill" style="width:${w}%"></span></span>
        <span class="cnt">${cnt}</span>
      </button>`;
    })
    .join("");
}

// "Around you" — 5 places above + 5 below me, with what they did this game
function renderNeighbors(g) {
  const el = $("#neighbors");
  const ranked = [...DATA.members].sort((a, b) => b.points - a.points);
  const myIdx = ranked.findIndex((m) => m.name === MY_NAME);
  if (myIdx < 0) { el.innerHTML = ""; return; }
  const myPts = ranked[myIdx].points;
  const start = Math.max(0, myIdx - 5);
  const slice = ranked.slice(start, Math.min(ranked.length, myIdx + 6));

  const rows = slice
    .map((m, i) => {
      const rank = start + i + 1;
      const b = g._byId[m.id];
      const gpts = b ? b.score ?? 0 : 0;
      const v = betClass(gpts, b?.g1, b?.g2, g.result1, g.result2);
      const betTxt = b && b.g1 != null ? `${b.g1}-${b.g2}` : "—";
      const me = m.name === MY_NAME;
      const diff = Math.round((m.points - myPts) * 10) / 10;
      const diffTxt = me ? "—" : diff > 0 ? `+${diff}` : `${diff}`;
      const diffCls = me ? "" : diff > 0 ? "ahead" : "behind";
      return `<tr class="${me ? "row-me" : ""}">
        <td class="rank">${rank}</td>
        <td><span class="name" dir="auto">${esc(m.name)}</span></td>
        <td class="num"><span class="bet ${v}">${betTxt}</span></td>
        <td class="num pts">${gpts}</td>
        <td class="num">${m.points}</td>
        <td class="num gap ${diffCls}">${diffTxt}</td>
      </tr>`;
    })
    .join("");

  el.innerHTML = `<h3>Around you <span class="muted">— your rivals in this game</span></h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th class="rank">#</th><th>Name</th><th class="num">Bet</th><th class="num">+Pts</th><th class="num">Total</th><th class="num">Gap to you</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ---------- Stats (per-manager scouting) ---------- */
// field-wide averages, for comparison
function fieldStats() {
  if (DATA._field) return DATA._field;
  let bets = 0, draw = 0, goals = 0, exact = 0, decided = 0;
  DATA.members.forEach((m) =>
    DATA.games.forEach((g) => {
      const b = g._byId[m.id];
      if (!b || b.g1 == null) return;
      bets++; goals += b.g1 + b.g2; if (b.g1 === b.g2) draw++;
      if (g.result1 != null) { decided++; if (b.g1 === g.result1 && b.g2 === g.result2) exact++; }
    })
  );
  return (DATA._field = {
    drawPct: bets ? (draw / bets) * 100 : 0,
    avgGoals: bets ? goals / bets : 0,
    exactPct: decided ? (exact / decided) * 100 : 0,
  });
}

function managerStats(id) {
  const m = DATA.members.find((x) => x.id === id) || DATA.ranked[0];
  let bets = 0, exact = 0, outcome = 0, wrong = 0, goals = 0, home = 0, draw = 0, away = 0, best = 0, favBacked = 0, favGames = 0;
  const sc = {};
  DATA.games.forEach((g) => {
    const b = g._byId[m.id];
    if (!b || b.g1 == null) return;
    bets++; goals += b.g1 + b.g2;
    sc[`${b.g1}-${b.g2}`] = (sc[`${b.g1}-${b.g2}`] || 0) + 1;
    if (b.g1 > b.g2) home++; else if (b.g1 < b.g2) away++; else draw++;
    best = Math.max(best, b.score || 0);
    if (g.odds && g.odds.home != null && g.odds.away != null) {
      favGames++;
      const favHome = g.odds.home <= g.odds.away;
      if ((favHome && b.g1 > b.g2) || (!favHome && b.g1 < b.g2)) favBacked++;
    }
    if (g.result1 != null) {
      if (b.g1 === g.result1 && b.g2 === g.result2) exact++;
      else if (Math.sign(b.g1 - b.g2) === Math.sign(g.result1 - g.result2)) outcome++;
      else wrong++;
    }
  });
  const decided = exact + outcome + wrong;
  const fav = Object.entries(sc).sort((a, b) => b[1] - a[1])[0] || ["—", 0];
  return {
    m, rank: DATA.rankById[m.id], bets, exact, outcome, wrong, decided, best,
    avgGoals: bets ? goals / bets : 0,
    homePct: bets ? (home / bets) * 100 : 0, drawPct: bets ? (draw / bets) * 100 : 0, awayPct: bets ? (away / bets) * 100 : 0,
    exactPct: decided ? (exact / decided) * 100 : 0, rightPct: decided ? ((exact + outcome) / decided) * 100 : 0,
    favScore: fav[0], favCount: fav[1], favBackPct: favGames ? (favBacked / favGames) * 100 : 0,
  };
}

// auto-generated "scouting report" lines from the numbers
function scouting(s, f) {
  const r = Math.round, out = [];
  if (s.drawPct >= Math.max(28, f.drawPct * 1.4)) out.push(`🤝 <b>Draw merchant</b> — predicts a draw ${r(s.drawPct)}% of the time (field avg ${r(f.drawPct)}%).`);
  if (s.avgGoals >= f.avgGoals + 0.6) out.push(`⚽ <b>Goal glutton</b> — averages ${s.avgGoals.toFixed(1)} goals/game (field ${f.avgGoals.toFixed(1)}).`);
  if (s.avgGoals <= f.avgGoals - 0.6) out.push(`🧱 <b>The Parker</b> — defensive, just ${s.avgGoals.toFixed(1)} goals/game (field ${f.avgGoals.toFixed(1)}).`);
  if (s.exactPct >= f.exactPct + 4) out.push(`🎯 <b>Sniper</b> — nails the exact score ${r(s.exactPct)}% (field ${r(f.exactPct)}%).`);
  if (s.favCount >= 8) out.push(`🔁 <b>Creature of habit</b> — bet <b>${esc(s.favScore)}</b> in ${s.favCount} different games.`);
  if (s.favBackPct >= 70) out.push(`💰 <b>Chalk-eater</b> — backs the bookies' favourite ${r(s.favBackPct)}% of the time.`);
  else if (s.favGames && s.favBackPct <= 45) out.push(`🃏 <b>Contrarian</b> — backs the favourite only ${r(s.favBackPct)}% — loves an upset.`);
  if (!out.length) out.push("🎲 <b>Wildcard</b> — no obvious pattern. Genuinely hard to read.");
  return out.slice(0, 4);
}

function buildMgrPicker() {
  $("#mgrPick").innerHTML = DATA.ranked.map((m) => `<option value="${m.id}">#${DATA.rankById[m.id]} ${esc(m.name)}</option>`).join("");
}

function renderStats() {
  if (!statMgrId) return;
  const s = managerStats(statMgrId), f = fieldStats(), m = s.m;
  $("#mgrPick").value = statMgrId;
  const pick = (p) => (p ? `<div class="pick"><img src="${img(p.img)}" loading="lazy" alt=""><span dir="auto">${esc(p.name)}</span></div>` : "—");
  const tile = (label, val, sub = "") => `<div class="tile"><div class="tval">${val}</div><div class="tlabel">${label}</div>${sub ? `<div class="tsub">${sub}</div>` : ""}</div>`;
  const bar = (label, pct, extra = "") =>
    `<div class="srow"><span class="sl">${label}</span><span class="sbar"><span style="width:${Math.round(pct)}%"></span></span><span class="sv">${Math.round(pct)}%${extra}</span></div>`;
  $("#statBody").innerHTML = `
    <div class="stat-head">
      <div><div class="sh-rank">#${s.rank}</div><div class="sh-name" dir="auto">${esc(m.name)}${m.name === MY_NAME ? ' <span class="muted">(you)</span>' : ""}</div></div>
      <div class="sh-pts">${m.points}<span class="muted"> pts</span></div>
    </div>
    <div class="picks-row">
      <div class="pickbox"><div class="muted">🏆 Champion pick</div>${pick(m.champion)}</div>
      <div class="pickbox"><div class="muted">⚽ Top scorer pick</div>${pick(m.scorer)}</div>
    </div>
    <div class="tiles">
      ${tile("Games bet", s.bets)}
      ${tile("Exact scores", s.exact, `${Math.round(s.exactPct)}% of decided`)}
      ${tile("Right result", s.outcome, "outcome only")}
      ${tile("Missed", s.wrong, `${Math.round(100 - s.rightPct)}% wrong`)}
      ${tile("Pts · guesses", m.pointsFromGuesses)}
      ${tile("Pts · top scorer", m.pointsFromScorer)}
      ${tile("Pts · champion", m.pointsFromChampion)}
      ${tile("Best game", s.best + " pts")}
    </div>
    <h3 class="stat-h">Playing style</h3>
    <div class="style">
      ${bar("Predicts a draw", s.drawPct, ` <span class="muted">· field ${Math.round(f.drawPct)}%</span>`)}
      ${bar("Backs the favourite", s.favBackPct, ` <span class="muted">· by odds</span>`)}
      <div class="srow"><span class="sl">Avg goals/game</span><span class="sv2">${s.avgGoals.toFixed(1)} <span class="muted">· field ${f.avgGoals.toFixed(1)}</span></span></div>
      <div class="srow"><span class="sl">Favourite scoreline</span><span class="sv2" dir="auto">${esc(s.favScore)} <span class="muted">×${s.favCount}</span></span></div>
    </div>
    <h3 class="stat-h">Scouting report 🕵️</h3>
    <ul class="scout">${scouting(s, f).map((x) => `<li>${x}</li>`).join("")}</ul>`;
}

/* ---------- Tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === name));
}

/* ---------- Wiring ---------- */
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("#lbSearch").addEventListener("input", renderLeaderboard);
$("#sbSearch").addEventListener("input", renderScoreboard);

// round navigation (RTL: left = newer round, right = older round)
$("#roundNewer").addEventListener("click", () => { if (roundIdx < DATA.rounds.length - 1) { roundIdx++; renderLeaderboard(); } });
$("#roundOlder").addEventListener("click", () => { if (roundIdx > 0) { roundIdx--; renderLeaderboard(); } });

// click a game column header → jump to that game in the Scoreboard
$("#lbWrap").addEventListener("click", (e) => {
  const th = e.target.closest("th.game");
  if (!th) return;
  gameIndex = +th.dataset.gi;
  scoreFilter = null;
  showTab("scoreboard");
  renderScoreboard();
});

// scoreboard game navigation (swapped: next on left, prev on right)
$("#gamePick").addEventListener("change", (e) => { gameIndex = +e.target.value; scoreFilter = null; renderScoreboard(); });
$("#prevGame").addEventListener("click", () => { if (gameIndex > 0) { gameIndex--; scoreFilter = null; renderScoreboard(); } });
$("#nextGame").addEventListener("click", () => { if (gameIndex < DATA.games.length - 1) { gameIndex++; scoreFilter = null; renderScoreboard(); } });

// distribution click → filter the list by that scoreline (click again to clear)
$("#sbDist").addEventListener("click", (e) => {
  const row = e.target.closest(".distrow");
  if (!row) return;
  scoreFilter = scoreFilter === row.dataset.score ? null : row.dataset.score;
  renderScoreboard();
});
$("#sbFilter").addEventListener("click", () => { scoreFilter = null; renderScoreboard(); });

// sort the scoreboard by overall Position or this-game Points
document.querySelectorAll("#scoreboard th.sortable").forEach((th) =>
  th.addEventListener("click", () => { sbSort = th.dataset.sort; renderScoreboard(); })
);

// Stats: pick a manager to scout (default = you), step through the table with ‹ ›
$("#mgrPick").addEventListener("change", (e) => { statMgrId = e.target.value; renderStats(); });
$("#mgrPrev").addEventListener("click", () => {
  const i = DATA.ranked.findIndex((m) => m.id === statMgrId);
  if (i > 0) { statMgrId = DATA.ranked[i - 1].id; renderStats(); }
});
$("#mgrNext").addEventListener("click", () => {
  const i = DATA.ranked.findIndex((m) => m.id === statMgrId);
  if (i < DATA.ranked.length - 1) { statMgrId = DATA.ranked[i + 1].id; renderStats(); }
});

refresh();
setInterval(refresh, 60_000); // page keeps itself fresh; heartbeat ticks even when idle
