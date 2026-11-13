import { Chessground } from '../vendor/chessground.min.js';
import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { fetchGames } from './lichess.js';
import { analyseGame, buildModel } from './analyze.js';
import { explainGame } from './explain.js';
import { findPatterns } from './patterns.js';
import { getAnalysis, putAnalysis, clearAnalysis } from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GLYPH = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const MOVETIME = { 12: 1000, 14: 2500, 16: 5000 };

const state = {
  games: [], // fetched games, newest first
  models: [], // analysed games (same order as games, may contain nulls while running)
  running: false,
  cancel: false,
  gi: -1, // selected game index
  pos: 0, // selected position index (0 = start, k = after move k)
  view: { mode: 'normal' }, // 'normal' | 'moment' | 'var' {which, idx}
  tab: 'report',
};

let cg = null;

// ---------- settings ----------
for (const id of ['username', 'count', 'perf', 'depth']) {
  const saved = localStorage.getItem(`choach.${id}`);
  const isSelect = $(id).tagName === 'SELECT';
  const valid = !isSelect || [...$(id).options].some((o) => o.value === saved);
  if (saved != null && valid) $(id).value = saved;
  $(id).addEventListener('change', () => localStorage.setItem(`choach.${id}`, $(id).value));
}

// ---------- running the analysis ----------
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.running) {
    state.cancel = true;
    $('go').textContent = 'Stopping…';
    return;
  }
  const username = $('username').value.trim();
  if (!username) return;
  localStorage.setItem('choach.username', username);
  await run(username, Number($('count').value), $('perf').value, Number($('depth').value));
});

function setProgress(text, frac) {
  $('progress').hidden = false;
  $('progress-text').textContent = text;
  if (frac != null) $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

async function run(username, count, perf, depth) {
  state.running = true;
  state.cancel = false;
  showError('');
  $('go').textContent = 'Stop';
  $('go').classList.add('stop');
  setProgress('Fetching games from Lichess…', 0);

  let engines = [];
  try {
    const games = await fetchGames(username, { max: count, perf });
    if (!games.length) throw new Error('No finished standard games found for that player and time control.');
    state.games = games;
    state.models = games.map(() => null);
    state.gi = -1;
    $('welcome').hidden = true;
    $('tabs').hidden = false;
    showTab(state.tab);
    renderGameList();
    renderReport();

    // Use cached analysis where we have it.
    const todo = [];
    for (let i = 0; i < games.length; i++) {
      const cached = await getAnalysis(`${games[i].id}:${depth}`);
      if (cached) finishGame(i, cached);
      else todo.push(i);
    }
    renderAll();

    if (todo.length) {
      const total = todo.reduce((s, i) => s + games[i].sans.length + 1, 0);
      const doneBy = new Map();
      const tick = () => {
        let done = 0;
        for (const v of doneBy.values()) done += v;
        const left = todo.filter((i) => !state.models[i]).length;
        setProgress(`Analysing with Stockfish: ${todo.length - left} of ${todo.length} games done`, done / total);
      };
      const workers = Math.min(todo.length, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)));
      setProgress('Starting the engine…', 0);
      engines = await Promise.all(
        Array.from({ length: workers }, async () => {
          const en = new Engine();
          await en.init();
          return en;
        })
      );
      let next = 0;
      await Promise.all(
        engines.map(async (engine) => {
          while (next < todo.length && !state.cancel) {
            const i = todo[next++];
            const positions = await analyseGame(
              engine,
              games[i],
              { depth, movetime: MOVETIME[depth] },
              (d) => {
                doneBy.set(i, d);
                tick();
              },
              () => state.cancel
            );
            if (!positions) break;
            await putAnalysis(`${games[i].id}:${depth}`, positions);
            finishGame(i, positions);
            renderAll();
            tick();
          }
        })
      );
    }
    const analysed = state.models.filter(Boolean).length;
    setProgress(state.cancel ? `Stopped. ${analysed} of ${games.length} games analysed.` : `Done. ${analysed} games analysed.`, state.cancel ? null : 1);
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
    $('progress').hidden = true;
  } finally {
    engines.forEach((en) => en.terminate());
    state.running = false;
    $('go').textContent = 'Analyse my games';
    $('go').classList.remove('stop');
  }
}

function finishGame(i, positions) {
  const model = buildModel(state.games[i], positions);
  model.explanations = explainGame(model);
  state.models[i] = model;
}

function renderAll() {
  renderGameList();
  renderReport();
  if (state.gi < 0) {
    const first = state.models.findIndex(Boolean);
    if (first >= 0) selectGame(first, null, false);
  }
}

// ---------- tabs ----------
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (tab) showTab(tab);
});

function showTab(tab) {
  state.tab = tab;
  for (const btn of $('tabs').children) btn.classList.toggle('active', btn.dataset.tab === tab);
  $('report').hidden = tab !== 'report';
  $('review').hidden = tab !== 'review';
  if (tab === 'review') {
    ensureBoard();
    renderReview();
  }
}

// ---------- report ----------
function exampleButtons(examples) {
  if (!examples?.length) return '';
  return `<div class="examples"><span class="lbl">See it:</span>${examples
    .map(
      (ex) =>
        `<button class="ex" data-gi="${ex.gi}" data-ply="${ex.ply}" title="${esc(ex.title)}"><span class="dot ${ex.cls}"></span>${esc(ex.label)} <span class="opp">vs ${esc(ex.opponent)}</span></button>`
    )
    .join('')}</div>`;
}

function renderReport() {
  const models = state.models.filter(Boolean);
  const el = $('report');
  if (!models.length) {
    el.innerHTML = `<p class="muted">Analysing… the report fills in as each game finishes.</p>`;
    return;
  }
  const giOf = new Map(models.map((m, k) => [k, state.models.indexOf(m)]));
  const r = findPatterns(models);
  const fix = (examples) => examples.map((ex) => ({ ...ex, gi: giOf.get(ex.gi) }));
  const s = r.summary;

  let html = `
    <div class="tiles">
      <div class="tile"><div class="num">${s.games}</div><div class="lbl">games analysed</div></div>
      <div class="tile"><div class="num">${s.win}–${s.draw}–${s.loss}</div><div class="lbl">wins – draws – losses</div></div>
      <div class="tile"><div class="num">${s.accuracy.toFixed(0)}%</div><div class="lbl">average accuracy</div></div>
      <div class="tile"><div class="num">${s.blunders.toFixed(1)}</div><div class="lbl">blunders per game</div></div>
      <div class="tile"><div class="num">${s.mistakes.toFixed(1)}</div><div class="lbl">mistakes per game</div></div>
    </div>`;

  html += `<h2 class="section-title">What to work on, in order</h2>
    <p class="section-sub">Your mistakes and blunders grouped by cause, ranked by how much winning chance each group cost you. Fixing the top one or two will do more than everything below them combined.</p>`;
  if (!r.themes.length) html += `<p class="muted">No mistakes or blunders found in these games.</p>`;
  r.themes.forEach((t, k) => {
    html += `<article class="insight">
      <div class="insight-head">
        <span class="rank">${k + 1}</span>
        <h3>${esc(t.title)}</h3>
        <span class="stat"><b>${t.count}</b> time${t.count === 1 ? '' : 's'} in <b>${t.games}</b> game${t.games === 1 ? '' : 's'} · <b>${t.share}%</b> of the damage</span>
      </div>
      <div class="share"><div style="width:${t.share}%"></div></div>
      <p>${t.what}</p>
      <div class="chips">${t.breakdown.map((b) => `<span class="chip">${esc(b.label)} <b>×${b.count}</b></span>`).join('')}</div>
      ${t.piece ? `<p>The piece you lose this way most often is the <b>${t.piece.name}</b> (${t.piece.count} of ${t.piece.of}).</p>` : ''}
      <div class="advice">${t.advice.map((a) => `<p>${a}</p>`).join('')}</div>
      ${t.drill ? `<p class="drill">${t.drill}</p>` : ''}
      ${exampleButtons(fix(t.examples))}
    </article>`;
  });

  if (r.habits.length) {
    html += `<h2 class="section-title">When and how it happens</h2>
      <p class="section-sub">Patterns in the circumstances around your mistakes, whatever type they were.</p>`;
    for (const h of r.habits) {
      html += `<article class="insight">
        <div class="insight-head"><h3>${esc(h.title)}</h3></div>
        <p>${h.body}</p>
        <div class="advice"><p>${h.advice}</p></div>
        ${exampleButtons(fix(h.examples))}
      </article>`;
    }
  }

  const maxPer = Math.max(...Object.values(r.phases).map((p) => p.per100), 1);
  html += `<h2 class="section-title">By phase and opening</h2><div class="two-col" style="margin-top:12px">
    <div class="panel"><h3>Mistakes and blunders per 100 moves</h3>
      ${Object.entries(r.phases)
        .map(
          ([name, p]) => `<div class="phase-row"><span>${name[0].toUpperCase() + name.slice(1)}</span>
            <div class="track"><div style="width:${(100 * p.per100) / maxPer}%"></div></div>
            <span class="v">${p.moves ? `${p.per100.toFixed(1)} <span class="muted">(${p.errors} in ${p.moves} moves)</span>` : 'no moves'}</span></div>`
        )
        .join('')}
      <p class="drill">Opening = first 12 moves. Endgame = once most pieces are off the board.</p>
    </div>
    <div class="panel"><h3>Openings</h3>
      <table><thead><tr><th>Opening</th><th class="num">Games</th><th class="num">W–D–L</th><th class="num">Accuracy</th><th class="num" title="Average engine evaluation from your side after move 12, in pawns">After move 12</th></tr></thead><tbody>
      ${r.openings
        .slice(0, 12)
        .map(
          (o) => `<tr><td><span class="piece-${o.color}"></span>${esc(o.name)}</td><td class="num">${o.games}</td><td class="num">${o.win}–${o.draw}–${o.loss}</td><td class="num">${o.acc.toFixed(0)}%</td><td class="num" style="color:${o.early <= -0.7 ? 'var(--blunder)' : o.early >= 0.7 ? 'var(--good)' : 'inherit'}">${o.early > 0 ? '+' : ''}${o.early.toFixed(1)}</td></tr>`
        )
        .join('')}
      </tbody></table>
      <p class="drill">The square shows the colour you played. "After move 12" is the average engine evaluation from your side, in pawns.</p>
    </div></div>`;

  el.innerHTML = html;
}

$('report').addEventListener('click', (e) => {
  const btn = e.target.closest('.ex');
  if (!btn) return;
  selectGame(Number(btn.dataset.gi), Number(btn.dataset.ply), true);
  showTab('review');
  window.scrollTo({ top: 0 });
});

// ---------- game list ----------
function renderGameList() {
  $('game-list').innerHTML = state.games
    .map((g, i) => {
      const m = state.models[i];
      const date = new Date(g.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const stats = m
        ? `<span>${m.accuracy.toFixed(0)}% acc</span><span class="b">${m.counts.blunder} ??</span><span class="m">${m.counts.mistake} ?</span>`
        : `<span>waiting for analysis…</span>`;
      return `<button class="game ${g.result} ${i === state.gi ? 'active' : ''}" data-gi="${i}" ${m ? '' : 'disabled'}>
        <div class="l1"><span>${g.userColor === 'w' ? '○' : '●'} vs ${esc(g.opponent)}</span><span>${g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Draw'}</span></div>
        <div class="l2">${esc(g.opening)}</div>
        <div class="l3"><span>${esc(g.speed)} · ${date}</span>${stats}</div>
      </button>`;
    })
    .join('');
}

$('game-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.game');
  if (btn) selectGame(Number(btn.dataset.gi), null, false);
});

function selectGame(gi, ply, moment) {
  const model = state.models[gi];
  if (!model) return;
  state.gi = gi;
  if (ply == null) {
    // open on the first real mistake, if there is one
    const first = model.moves.find((m) => m.isUser && (m.cls === 'blunder' || m.cls === 'mistake'));
    state.pos = first ? first.ply + 1 : 0;
    state.view = { mode: first ? 'moment' : 'normal' };
  } else {
    state.pos = ply + 1;
    state.view = { mode: moment ? 'moment' : 'normal' };
  }
  renderGameList();
  if (state.tab === 'review') renderReview();
}

// ---------- review ----------
function ensureBoard() {
  if (cg) return;
  cg = Chessground($('board'), {
    viewOnly: true,
    coordinates: true,
    animation: { enabled: true, duration: 160 },
    drawable: { enabled: false, visible: true },
  });
  window.addEventListener('resize', () => cg.redrawAll());
}

function lineTokens(line, which, activeIdx) {
  // line: {fen, moves[]} -> clickable SAN tokens with move numbers
  const parts = line.fen.split(' ');
  let no = Number(parts[5]) || 1;
  let white = parts[1] === 'w';
  let html = '';
  line.moves.forEach((m, k) => {
    if (white) html += `<span class="n">${no}.</span>`;
    else if (k === 0) html += `<span class="n">${no}…</span>`;
    html += `<button class="tok ${activeIdx === k ? 'on' : ''}" data-which="${which}" data-idx="${k}">${esc(m.san)}</button>`;
    if (!white) no++;
    white = !white;
  });
  return `<div class="line ${which === 'ref' ? 'bad' : ''}">${html}</div>`;
}

function renderCard(model) {
  const mv = state.pos > 0 ? model.moves[state.pos - 1] : null;
  const ex = mv ? model.explanations[mv.ply] : null;
  const card = $('card');
  if (!mv) {
    const g = model.game;
    card.className = 'card';
    card.innerHTML = `<h3>${esc(g.white)} vs ${esc(g.black)}</h3>
      <p class="muted">${esc(g.opening)} · ${esc(g.speed)} · <a href="${g.url}" target="_blank" rel="noopener" style="color:inherit">open on Lichess</a></p>
      <p>Your accuracy: <b>${model.accuracy.toFixed(0)}%</b> (opponent ${model.oppAccuracy.toFixed(0)}%). You made <b>${model.counts.blunder}</b> blunder${model.counts.blunder === 1 ? '' : 's'}, <b>${model.counts.mistake}</b> mistake${model.counts.mistake === 1 ? '' : 's'} and ${model.counts.inaccuracy} inaccurac${model.counts.inaccuracy === 1 ? 'y' : 'ies'}.</p>
      <p class="muted">Use the <b>mistake ▶</b> button to jump through the moments that mattered, or click any coloured move.</p>`;
    return;
  }
  if (!ex) {
    card.className = 'card quiet';
    const who = mv.isUser ? 'Your move' : "Opponent's move";
    let note = 'Nothing wrong with this move.';
    if (!mv.isUser && mv.cls !== 'ok') note = `This was ${mv.cls === 'inaccuracy' ? 'an inaccuracy' : `a ${mv.cls}`} by your opponent. Check the next move to see whether you took advantage.`;
    card.innerHTML = `<b>${esc(mv.label)}</b> · ${who}. ${note}`;
    return;
  }
  const v = state.view;
  card.className = 'card';
  card.innerHTML = `
    <div><span class="badge ${ex.cls}">${ex.cls}</span><span class="meta">${mv.wpBefore.toFixed(0)}% → ${mv.wpAfter.toFixed(0)}% winning chances · ${ex.phase}</span></div>
    <h3>${esc(mv.label)}${GLYPH[ex.cls]} — ${esc(ex.title)}</h3>
    ${ex.why.map((p) => `<p>${p}</p>`).join('')}
    ${ex.refLine.moves.length ? `<h4>How it gets punished (click to step through)</h4>${lineTokens(ex.refLine, 'ref', v.mode === 'var' && v.which === 'ref' ? v.idx : -1)}` : ''}
    <h4>What was better</h4>
    ${ex.better ? `<p>${ex.better}</p>` : ''}
    ${ex.bestLine.moves.length ? lineTokens(ex.bestLine, 'best', v.mode === 'var' && v.which === 'best' ? v.idx : -1) : ''}
    ${ex.context.length ? `<h4>Worth noticing</h4><ul>${ex.context.map((c) => `<li>${c}</li>`).join('')}</ul>` : ''}
    <div class="actions">
      <button data-act="moment" class="${v.mode === 'moment' ? 'on' : ''}">Position before: your move vs better</button>
      <button data-act="normal" class="${v.mode === 'normal' ? 'on' : ''}">Position after your move</button>
    </div>`;
}

$('card').addEventListener('click', (e) => {
  const tok = e.target.closest('.tok');
  if (tok) {
    state.view = { mode: 'var', which: tok.dataset.which, idx: Number(tok.dataset.idx) };
    renderReview();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    state.view = { mode: act.dataset.act };
    renderReview();
  }
});

function renderMoves(model) {
  let html = '';
  model.moves.forEach((mv, k) => {
    if (mv.color === 'w') html += `<span class="no">${mv.moveNo}.</span>`;
    else if (k === 0) html += `<span class="no">${mv.moveNo}.</span><span></span>`;
    const cls = mv.cls !== 'ok' ? mv.cls : '';
    html += `<button class="mv ${mv.isUser ? cls : 'opp'} ${state.pos === k + 1 ? 'cur' : ''}" data-pos="${k + 1}">${esc(mv.san)}${mv.cls !== 'ok' ? `<sup>${GLYPH[mv.cls]}</sup>` : ''}</button>`;
  });
  $('moves').innerHTML = html;
  const cur = $('moves').querySelector('.cur');
  if (cur) {
    const box = $('moves');
    const top = cur.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = top - box.clientHeight / 2;
  }
}

$('moves').addEventListener('click', (e) => {
  const btn = e.target.closest('.mv');
  if (btn) goTo(Number(btn.dataset.pos));
});

function renderGraph(model) {
  const n = model.positions.length;
  const W = 600;
  const H = 84;
  const sign = model.game.userColor === 'w' ? 1 : -1;
  const wp = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * sign * cp)) - 1);
  const x = (i) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (i) => H - (wp(model.positions[i].cp) / 100) * H;
  let d = `M0,${H} `;
  for (let i = 0; i < n; i++) d += `L${x(i).toFixed(1)},${y(i).toFixed(1)} `;
  d += `L${W},${H} Z`;
  const dots = model.moves
    .filter((m) => m.isUser && (m.cls === 'blunder' || m.cls === 'mistake'))
    .map((m) => `<circle cx="${x(m.ply + 1).toFixed(1)}" cy="${y(m.ply + 1).toFixed(1)}" r="3.5" fill="var(--${m.cls})"/>`)
    .join('');
  $('graph').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <rect width="${W}" height="${H}" fill="#2a2e38"/>
    <path d="${d}" fill="#d9dce3"/>
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#7a8194" stroke-width="1" stroke-dasharray="3 3"/>
    ${dots}
    <line x1="${x(state.pos)}" x2="${x(state.pos)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="2"/>
    <title>Your winning chances through the game (higher is better for you)</title>
  </svg>`;
}

$('graph').addEventListener('click', (e) => {
  const model = state.models[state.gi];
  if (!model) return;
  const rect = $('graph').getBoundingClientRect();
  goTo(Math.round(((e.clientX - rect.left) / rect.width) * (model.positions.length - 1)));
});

function renderBoard(model) {
  const g = model.game;
  const mv = state.pos > 0 ? model.moves[state.pos - 1] : null;
  const ex = mv ? model.explanations[mv.ply] : null;
  let v = state.view;
  if ((v.mode === 'moment' || v.mode === 'var') && !ex) v = state.view = { mode: 'normal' };

  let fen;
  let last = null;
  const shapes = [];
  let note = '';
  if (v.mode === 'moment') {
    fen = model.positions[state.pos - 1].fen;
    shapes.push({ orig: mv.obj.from, dest: mv.obj.to, brush: 'red' });
    const best = ex.bestLine.moves[0];
    if (best) shapes.push({ orig: best.from, dest: best.to, brush: 'green' });
    note = `<span>Position before ${esc(mv.label)}</span><span class="key"><i style="background:#b33"></i>what you played</span><span class="key"><i style="background:#2a9a35"></i>what was better</span>`;
  } else if (v.mode === 'var') {
    const line = v.which === 'ref' ? ex.refLine : ex.bestLine;
    const m = line.moves[Math.min(v.idx, line.moves.length - 1)];
    fen = m.after;
    last = [m.from, m.to];
    note = `<span>${v.which === 'ref' ? 'The punishment' : 'The better line'}, move ${v.idx + 1} of ${line.moves.length}. Use ← → to step, Esc to return to the game.</span>`;
  } else {
    fen = model.positions[state.pos].fen;
    if (mv) last = [mv.obj.from, mv.obj.to];
    if (ex && ex.refLine.moves[0]) {
      const r = ex.refLine.moves[0];
      shapes.push({ orig: r.from, dest: r.to, brush: 'red' });
      note = `<span>Position after ${esc(mv.label)}</span><span class="key"><i style="background:#b33"></i>the reply that punishes it</span>`;
    }
  }
  const c = new Chess(fen);
  cg.set({
    fen,
    orientation: g.userColor === 'w' ? 'white' : 'black',
    lastMove: last || undefined,
    turnColor: c.turn() === 'w' ? 'white' : 'black',
    check: c.inCheck(),
  });
  if (!last) cg.set({ lastMove: undefined });
  cg.setAutoShapes(shapes);
  $('view-note').innerHTML = note;

  const top = g.userColor === 'w' ? 'b' : 'w';
  const nameOf = (col) => `<b>${esc(col === 'w' ? g.white : g.black)}</b> ${col === 'w' ? g.whiteRating ?? '' : g.blackRating ?? ''}`;
  $('player-top').innerHTML = `<span>${nameOf(top)}</span><span>${top === 'w' ? 'White' : 'Black'}</span>`;
  $('player-bottom').innerHTML = `<span>${nameOf(g.userColor)} (you)</span><span>${g.userColor === 'w' ? 'White' : 'Black'}</span>`;
}

function renderReview() {
  const model = state.models[state.gi];
  if (!model || !cg) return;
  renderBoard(model);
  renderCard(model);
  renderMoves(model);
  renderGraph(model);
}

function goTo(pos) {
  const model = state.models[state.gi];
  if (!model) return;
  state.pos = Math.max(0, Math.min(model.positions.length - 1, pos));
  state.view = { mode: 'normal' };
  renderReview();
}

function jumpError(dir) {
  const model = state.models[state.gi];
  if (!model) return;
  const flagged = model.moves.filter((m) => m.isUser && m.cls !== 'ok' && m.cls !== 'inaccuracy').map((m) => m.ply + 1);
  const target = dir > 0 ? flagged.find((p) => p > state.pos) : [...flagged].reverse().find((p) => p < state.pos);
  if (target == null) return;
  state.pos = target;
  state.view = { mode: 'moment' };
  renderReview();
}

function step(dir) {
  const model = state.models[state.gi];
  if (!model) return;
  const v = state.view;
  if (v.mode === 'var') {
    const ex = model.explanations[state.pos - 1];
    const line = v.which === 'ref' ? ex.refLine : ex.bestLine;
    const idx = v.idx + dir;
    if (idx < 0) state.view = { mode: v.which === 'ref' ? 'normal' : 'moment' };
    else state.view = { ...v, idx: Math.min(line.moves.length - 1, idx) };
    renderReview();
  } else if (v.mode === 'moment' && dir > 0) {
    state.view = { mode: 'normal' };
    renderReview();
  } else {
    goTo(state.pos + dir);
  }
}

$('nav-first').onclick = () => goTo(0);
$('nav-last').onclick = () => goTo(Infinity);
$('nav-prev').onclick = () => step(-1);
$('nav-next').onclick = () => step(1);
$('nav-prev-err').onclick = () => jumpError(-1);
$('nav-next-err').onclick = () => jumpError(1);

document.addEventListener('keydown', (e) => {
  if (state.tab !== 'review' || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Escape' && state.view.mode === 'var') {
    state.view = { mode: 'normal' };
    renderReview();
  } else return;
  e.preventDefault();
});

$('clear-cache').onclick = async () => {
  await clearAnalysis();
  $('clear-cache').textContent = 'Saved analysis cleared';
};

// expose for debugging in the console
window.choach = state;
