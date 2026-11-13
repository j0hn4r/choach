// Looks across all analysed games for recurring themes and turns them into a
// ranked list of things to work on.

import { TAGS, NAME } from './explain.js';

const THEMES = [
  {
    id: 'loose',
    title: 'Leaving pieces where they can be taken',
    tags: ['hung-piece', 'bad-exchange', 'ignored-threat', 'removed-defender', 'uncovered-attack'],
    what: 'These are one-move oversights: after your move, the opponent could simply capture something. No deep calculation was needed to avoid them.',
    advice: {
      'hung-piece': 'Before letting go of the piece, look at the square it is landing on and ask: "what attacks this square, and what defends it?" Count both.',
      'bad-exchange': 'Before capturing, count attackers and defenders on that square, and compare the value of what you take with what you lose if they recapture.',
      'ignored-threat': 'Start every turn by asking "what did their last move attack?" before thinking about your own plans.',
      'removed-defender': 'Before moving a piece, ask what it is currently guarding. A piece that is the only defender of something already has a job.',
      'uncovered-attack': 'Before moving a piece, look along the files and diagonals it is standing on. If it is shielding something bigger, it is not free to move.',
    },
    drill: 'Practice: Lichess puzzle themes "Hanging piece" and "Defensive move", and a 5-second blunder check before every move ("checks, captures, threats" for both sides).',
  },
  {
    id: 'tactics-against',
    title: 'Walking into the opponent\'s tactics',
    tags: ['allowed-fork', 'allowed-pin', 'allowed-skewer', 'allowed-discovered', 'allowed-trap', 'allowed-promotion', 'lost-material'],
    what: 'Here nothing was hanging right away, but your move allowed a two-move idea (a fork, pin, skewer or similar) that won material.',
    advice: {
      'allowed-fork': 'Forks need two targets. Watch for your pieces lining up a knight-move apart, or your king and a loose piece on the same line or colour, and check which squares enemy knights and queens can reach in one move.',
      'allowed-pin': 'Be careful putting a piece in front of your king or queen on an open file or diagonal: if an enemy bishop, rook or queen can attack it there, it may never get out.',
      'allowed-skewer': 'Avoid lining up your king or queen with another piece behind it on an open line.',
      'allowed-discovered': 'When an enemy piece sits between one of their long-range pieces and something of yours, treat the piece in the middle as loaded: it can move anywhere with tempo.',
      'allowed-trap': 'Before advancing a piece deep into enemy territory, check that it has a way back out.',
      'allowed-promotion': 'In endgames, count the race: how many moves does their pawn need to promote, and can your king or a piece get there first?',
      'lost-material': 'After picking your move, imagine it played and look for the opponent\'s forcing replies: every check, every capture, every attack on a loose piece.',
    },
    drill: 'Practice: Lichess puzzle themes "Fork", "Pin", "Skewer" and "Discovered attack". Solving them from the attacker\'s side is how you learn to spot them coming.',
  },
  {
    id: 'mate',
    title: 'Missing mating threats against your king',
    tags: ['allowed-mate'],
    what: 'In these positions your move allowed a forced checkmate.',
    advice: {
      'allowed-mate': 'When enemy pieces are gathering near your king, check every one of their checks before each move, and give your king an escape square before it is urgent.',
    },
    drill: 'Practice: Lichess puzzle themes "Mate in 1", "Mate in 2" and "Back rank mate".',
  },
  {
    id: 'missed',
    title: 'Missing your own tactical chances',
    tags: ['missed-mate', 'missed-free-piece', 'missed-capture', 'missed-fork', 'missed-pin', 'missed-skewer', 'missed-discovered', 'missed-trap', 'missed-promotion', 'missed-tactic'],
    what: 'These are moments where you could have won material or the game, and played something else. They do not feel like mistakes during the game, which is why they are easy to repeat.',
    advice: {
      'missed-free-piece': 'After every opponent move, scan for pieces of theirs that nothing defends. Undefended pieces are where tactics come from.',
      'missed-capture': 'Look at every capture available to you, even the ones that look defended, and count attackers against defenders.',
      'missed-mate': 'When the enemy king is short of squares, look at every check first, however odd it looks.',
      'missed-fork': 'Look for squares where one of your pieces would attack two things at once, especially knight hops and queen checks.',
      'missed-tactic': 'Use the "checks, captures, threats" scan on your own moves before settling for a quiet one.',
    },
    drill: 'Practice: Lichess "Puzzle Streak" or mixed puzzles, slowly. The aim is to build the habit of looking for forcing moves first.',
  },
  {
    id: 'king',
    title: 'King safety',
    tags: ['king-safety'],
    what: 'No material was lost at once, but the move left your king exposed: delaying castling, giving up castling rights, loosening the pawns in front of the king, or allowing an attack to build.',
    advice: {
      'king-safety': 'Castle early, and think twice before pushing the pawns in front of your castled king unless you have a concrete reason.',
    },
    drill: 'Practice: Lichess puzzle themes "Kingside attack" and "Exposed king" (seeing how attacks work makes you respect them).',
  },
  {
    id: 'opening',
    title: 'Opening principles',
    tags: ['opening-principles'],
    what: 'Early moves that fell behind in development: extra pawn moves, moving the same piece twice, or an early queen sortie.',
    advice: {
      'opening-principles': 'For the first ten moves, aim for: a pawn in the centre, knights and bishops out, king castled, rooks connected. Move each piece once.',
    },
    drill: 'Practice: pick one opening as White and one defence each against 1.e4 and 1.d4 and play them every game, so the first moves become familiar.',
  },
  {
    id: 'positional',
    title: 'Positional and strategic slips',
    tags: ['positional', 'bad-trade'],
    what: 'Moves where nothing was lost immediately but the position got worse: a passive piece, a bad trade, a missed chance to improve. These are the hardest to see and usually matter least until the tactical errors above are under control.',
    advice: {
      positional: 'Open these examples and step through the engine\'s preferred line: look at which piece it improves and where. One recurring idea is worth more than memorised rules.',
      'bad-trade': 'Trade pieces when you are ahead, keep them on when you are behind.',
    },
    drill: '',
  },
];

function example(gi, model, ex) {
  const mv = model.moves[ex.ply];
  return {
    gi,
    ply: ex.ply,
    label: mv.label,
    opponent: model.game.opponent,
    cls: ex.cls,
    loss: ex.loss,
    title: TAGS[ex.primary] || '',
  };
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

export function findPatterns(models) {
  const n = models.length;
  const all = []; // every explained user error with its game
  models.forEach((model, gi) => {
    for (const ex of Object.values(model.explanations || {})) all.push({ gi, model, ex });
  });
  const errors = all.filter((e) => e.ex.cls !== 'inaccuracy');
  const totalLoss = errors.reduce((s, e) => s + e.ex.loss, 0) || 1;

  // ---------- themes ----------
  const themes = [];
  for (const th of THEMES) {
    const hits = errors.filter((e) => th.tags.includes(e.ex.primary));
    if (!hits.length) continue;
    const bySub = {};
    const byPiece = {};
    for (const h of hits) {
      bySub[h.ex.primary] = (bySub[h.ex.primary] || 0) + 1;
      if (h.ex.lostPiece) byPiece[h.ex.lostPiece] = (byPiece[h.ex.lostPiece] || 0) + 1;
    }
    const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]);
    const pieces = Object.entries(byPiece).sort((a, b) => b[1] - a[1]);
    const cost = hits.reduce((s, h) => s + h.ex.loss, 0);
    themes.push({
      id: th.id,
      title: th.title,
      what: th.what,
      count: hits.length,
      games: new Set(hits.map((h) => h.gi)).size,
      share: pct(cost, totalLoss),
      cost,
      breakdown: subs.map(([tag, c]) => ({ tag, label: TAGS[tag], count: c })),
      piece: th.id === 'loose' && pieces.length && pieces[0][1] >= 2 ? { type: pieces[0][0], name: NAME[pieces[0][0]], count: pieces[0][1], of: hits.length } : null,
      advice: subs.slice(0, 2).map(([tag]) => th.advice[tag]).filter(Boolean),
      drill: th.drill,
      examples: hits.sort((a, b) => b.ex.loss - a.ex.loss).slice(0, 8).map((h) => example(h.gi, h.model, h.ex)),
    });
  }
  themes.sort((a, b) => b.cost - a.cost);

  // ---------- habits: when and how the errors happen ----------
  const habits = [];
  const has = (e, t) => e.ex.tags.includes(t);
  const pick = (list) => list.sort((a, b) => b.ex.loss - a.ex.loss).slice(0, 6).map((h) => example(h.gi, h.model, h.ex));

  const fromThreat = errors.filter((e) => has(e, 'origin-threat'));
  const fromSelf = errors.filter((e) => has(e, 'origin-self'));
  if (fromThreat.length + fromSelf.length >= 3) {
    const t = fromThreat.length;
    const s = fromSelf.length;
    if (t > s * 1.3) {
      habits.push({
        id: 'threat-blind',
        title: 'You tend to miss what the opponent\'s last move threatened',
        body: `Of the ${t + s} times you lost material or got mated, <b>${t}</b> were threats that were already on the board before you moved, against ${s} that your own move created. The damage is mostly coming from not looking at their move, more than from carelessness with yours.`,
        advice: 'Make "what does that move threaten, and what did it stop defending?" the first thing you do every turn, before looking at your own ideas.',
        examples: pick(fromThreat),
      });
    } else if (s > t * 1.3) {
      habits.push({
        id: 'self-inflicted',
        title: 'Most of your losses are created by your own move',
        body: `Of the ${t + s} times you lost material or got mated, <b>${s}</b> were problems that did not exist until your move created them (moving a defender, stepping onto an attacked square, opening a line), against ${t} that were existing threats you overlooked.`,
        advice: 'Add a final check after you have chosen a move and before you play it: picture the piece on its new square and ask what it no longer defends, what can now capture it, and what line it has opened.',
        examples: pick(fromSelf),
      });
    } else {
      habits.push({
        id: 'threat-mixed',
        title: 'Material losses split evenly between two causes',
        body: `Of the ${t + s} times you lost material or got mated, ${t} were existing threats you did not deal with and ${s} were created by your own move.`,
        advice: 'Two checks cover both: at the start of your turn, "what does their move threaten?"; before you let go of the piece, "what does my move leave undefended?"',
        examples: pick([...fromThreat, ...fromSelf]),
      });
    }
  }

  const clocked = errors.filter((e) => e.model.moves[e.ex.ply].clockBefore != null);
  const rushed = clocked.filter((e) => has(e, 'rushed'));
  const trouble = clocked.filter((e) => has(e, 'time-trouble'));
  if (clocked.length >= 4 && rushed.length >= 2 && rushed.length / clocked.length >= 0.25) {
    habits.push({
      id: 'rushed',
      title: 'Many mistakes are played quickly with plenty of time left',
      body: `<b>${rushed.length} of ${clocked.length}</b> mistakes and blunders (${pct(rushed.length, clocked.length)}%) were played much faster than your time budget allowed, with no clock pressure.`,
      advice: 'These are the cheapest errors to fix. Captures, recaptures and "obvious" moves are where it happens most: sit on your hands for a few seconds and run the blunder check.',
      examples: pick(rushed),
    });
  }
  if (clocked.length >= 4 && trouble.length >= 2 && trouble.length / clocked.length >= 0.2) {
    habits.push({
      id: 'time-trouble',
      title: 'Time trouble is costing you',
      body: `<b>${trouble.length} of ${clocked.length}</b> mistakes and blunders (${pct(trouble.length, clocked.length)}%) came when you were down to your last tenth of the clock.`,
      advice: 'Spend less time in the opening and on quiet positions so there is some left for the critical moments, or try a time control with a bigger increment.',
      examples: pick(trouble),
    });
  }

  // Converting winning positions
  const blown = [];
  models.forEach((model, gi) => {
    if (model.game.result === 'win') return;
    let peak = null;
    for (const mv of model.moves) {
      if (mv.isUser && mv.wpBefore >= 85 && (!peak || mv.wpBefore > peak.wpBefore)) peak = mv;
    }
    if (!peak) return;
    const culprit = Object.values(model.explanations)
      .filter((ex) => ex.ply >= peak.ply && ex.cls !== 'inaccuracy')
      .sort((a, b) => b.loss - a.loss)[0];
    if (culprit) blown.push({ gi, model, ex: culprit });
  });
  const hadWinning = models.filter((m) => m.moves.some((mv) => mv.isUser && mv.wpBefore >= 85)).length;
  if (blown.length >= 2) {
    habits.push({
      id: 'conversion',
      title: 'Winning positions are slipping away',
      body: `You reached a clearly winning position in ${hadWinning} of ${n} games, and <b>${blown.length}</b> of those ended in a draw or a loss. The examples are the moves where each one turned.`,
      advice: 'When you are winning, the job changes: stop looking for the brilliant finish, trade pieces (not pawns), keep everything defended, and ask what counterplay the opponent has left before every move.',
      examples: pick(blown),
    });
  }

  const gifts = errors.filter((e) => has(e, 'missed-punish'));
  if (gifts.length >= 3) {
    habits.push({
      id: 'missed-punish',
      title: 'Opponent mistakes go unpunished',
      body: `<b>${gifts.length}</b> of your errors came on the move straight after your opponent made a mistake of their own. Those were the moments the game was there to be taken.`,
      advice: 'When an opponent\'s move surprises you or looks odd, treat it as a signal: stop and ask what it left undefended before carrying on with your plan.',
      examples: pick(gifts),
    });
  }

  // ---------- phases ----------
  const phases = { opening: { moves: 0, loss: 0, errors: 0 }, middlegame: { moves: 0, loss: 0, errors: 0 }, endgame: { moves: 0, loss: 0, errors: 0 } };
  for (const model of models) {
    for (const mv of model.moves) {
      if (!mv.isUser) continue;
      const p = phases[mv.phase];
      p.moves++;
      p.loss += mv.loss;
      if (mv.cls === 'mistake' || mv.cls === 'blunder') p.errors++;
    }
  }
  for (const p of Object.values(phases)) {
    p.per100 = p.moves ? (100 * p.errors) / p.moves : 0;
    p.avgLoss = p.moves ? p.loss / p.moves : 0;
  }
  const ranked = Object.entries(phases).filter(([, p]) => p.moves >= 30).sort((a, b) => b[1].per100 - a[1].per100);
  if (ranked.length >= 2 && ranked[0][1].per100 > ranked[ranked.length - 1][1].per100 * 1.5 && ranked[0][1].errors >= 3) {
    const [name, p] = ranked[0];
    const tips = {
      opening: 'Your games are being decided early. A small, consistent opening repertoire will get you to playable middlegames more often.',
      middlegame: 'This is where tactics live. Regular puzzle practice is the most direct way to bring this down.',
      endgame: 'Endgames reward a little study disproportionately: king activity, passed pawns and basic rook endings. Lichess\'s Practice section covers the essentials.',
    };
    habits.push({
      id: 'phase',
      title: `Your ${name} is the weakest phase`,
      body: `You make <b>${p.per100.toFixed(1)}</b> mistakes or blunders per 100 moves in the ${name}, against ${ranked[ranked.length - 1][1].per100.toFixed(1)} in the ${ranked[ranked.length - 1][0]}.`,
      advice: tips[name],
      examples: pick(errors.filter((e) => e.ex.phase === name)),
    });
  }

  // ---------- openings ----------
  const openMap = new Map();
  for (const model of models) {
    const g = model.game;
    const family = g.opening.split(':')[0].split(',')[0].trim();
    const key = `${g.userColor}|${family}`;
    if (!openMap.has(key)) openMap.set(key, { name: family, color: g.userColor, games: 0, win: 0, draw: 0, loss: 0, acc: 0, early: 0 });
    const o = openMap.get(key);
    o.games++;
    o[g.result]++;
    o.acc += model.accuracy;
    // how you stand coming out of the opening (after move 12, or at the end if shorter)
    const idx = Math.min(24, model.positions.length - 1);
    const cp = model.positions[idx].cp * (g.userColor === 'w' ? 1 : -1);
    o.early += Math.max(-600, Math.min(600, cp));
  }
  const openings = [...openMap.values()]
    .map((o) => ({ ...o, acc: o.acc / o.games, early: o.early / o.games / 100 }))
    .sort((a, b) => b.games - a.games);

  // ---------- summary ----------
  const sum = (f) => models.reduce((s, m) => s + f(m), 0);
  const summary = {
    games: n,
    win: models.filter((m) => m.game.result === 'win').length,
    draw: models.filter((m) => m.game.result === 'draw').length,
    loss: models.filter((m) => m.game.result === 'loss').length,
    accuracy: n ? sum((m) => m.accuracy) / n : 0,
    blunders: n ? sum((m) => m.counts.blunder) / n : 0,
    mistakes: n ? sum((m) => m.counts.mistake) / n : 0,
    inaccuracies: n ? sum((m) => m.counts.inaccuracy) / n : 0,
    errors: errors.length,
  };

  return { summary, themes, habits, phases, openings };
}
