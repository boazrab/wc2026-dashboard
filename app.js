// Reads data/dashboard.json and renders the two views.
const IMG_BASE = "https://hevre.sport5.co.il/";
const MY_NAME = "Boaz Rabinovitz"; // highlight my own row

let DATA = null;
let gameIndex = 0;     // scoreboard: which game is shown
let roundIdx = 0;      // leaderboard: which round is shown
let scoreFilter = null; // scoreboard: only show people who bet this scoreline

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

async function load() {
  DATA = await (await fetch("./data/dashboard.json")).json();

  // index each game's bets by friend id
  DATA.games.forEach((g) => {
    g._byId = {};
    g.bets.forEach((b) => { g._byId[b.id] = b; });
  });

  // group games into rounds (in order of first appearance)
  DATA.rounds = [];
  const seen = new Map();
  DATA.games.forEach((g, i) => {
    if (!seen.has(g.round)) { seen.set(g.round, DATA.rounds.length); DATA.rounds.push({ name: g.round, idxs: [] }); }
    DATA.rounds[seen.get(g.round)].idxs.push(i);
  });
  roundIdx = DATA.rounds.length - 1; // default = current (latest) round

  $("#subtitle").textContent = `${DATA.group.name} · ${DATA.members.length} players · ${DATA.games.length} games · updated ${fmtUpdated(DATA.generatedAt)}`;

  // default scoreboard to the most recent played game
  const lastPlayed = DATA.games.map((g, i) => (g.result1 != null ? i : -1)).filter((i) => i >= 0).pop();
  gameIndex = lastPlayed ?? DATA.games.length - 1;

  buildGamePicker();
  renderLeaderboard();
  renderScoreboard();
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
  const bets = [...g.bets]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((b) => !q || (b.name || "").toLowerCase().includes(q))
    .filter((b) => !scoreFilter || (b.g1 != null && `${b.g1}-${b.g2}` === scoreFilter));

  $("#sbBody").innerHTML = bets
    .map((b, i) => {
      const v = betClass(b.score ?? 0, b.g1, b.g2, g.result1, g.result2);
      const me = b.name === MY_NAME ? "row-me" : "";
      const betTxt = b.g1 == null ? "—" : `${b.g1}-${b.g2}`;
      return `<tr class="${me}">
        <td class="rank">${i + 1}</td>
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

load();
