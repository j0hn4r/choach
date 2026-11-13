// Runs Stockfish over every position in a game and turns the raw scores into
// per-move judgements (win-chance lost, inaccuracy / mistake / blunder, phase, clock).

import { Chess } from '../vendor/chess.js';

export const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Lichess's win-chance curve: centipawns -> win % for the side the score is for. */
export function winPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function replay(sans) {
  const chess = new Chess();
  const objs = [];
  for (const san of sans) {
    try {
      objs.push(chess.move(san));
    } catch {
      break; // unparseable move: analyse what we have
    }
  }
  return objs;
}

/**
 * Engine pass. Returns positions[0..n], each {fen, cp, mate, best, pv, over} with
 * cp/mate from White's point of view.
 */
export async function analyseGame(engine, game, { depth, movetime }, onProgress, isCancelled) {
  const objs = replay(game.sans);
  const fens = [objs.length ? objs[0].before : new Chess().fen(), ...objs.map((m) => m.after)];
  const positions = new Array(fens.length);
  await engine.newGame();

  // Walk backwards: the hash table then already knows what happens next, which
  // makes the scores of neighbouring positions more consistent.
  for (let i = fens.length - 1; i >= 0; i--) {
    if (isCancelled && isCancelled()) return null;
    const fen = fens[i];
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    const c = new Chess(fen);
    if (c.isCheckmate()) {
      positions[i] = { fen, cp: -sign * 10000, mate: null, best: null, pv: [], over: 'mate' };
    } else if (c.isStalemate() || c.isInsufficientMaterial()) {
      positions[i] = { fen, cp: 0, mate: null, best: null, pv: [], over: 'draw' };
    } else {
      const r = await engine.analyse(fen, depth, movetime);
      let cp;
      if (r.mate != null) cp = r.mate > 0 ? 10000 - r.mate * 10 : -10000 - r.mate * 10;
      else cp = Math.max(-9000, Math.min(9000, r.cp ?? 0));
      positions[i] = {
        fen,
        cp: sign * cp,
        mate: r.mate != null ? sign * r.mate : null,
        best: r.best,
        pv: r.pv && r.pv.length ? r.pv : r.best ? [r.best] : [],
        over: null,
      };
    }
    if (onProgress) onProgress(fens.length - i, fens.length);
  }
  return positions;
}

function phaseOf(fen, moveNo) {
  let npm = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = VAL[ch.toLowerCase()];
    if (v && v > 1) npm += v;
  }
  if (npm <= 26) return 'endgame';
  if (moveNo <= 12) return 'opening';
  return 'middlegame';
}

/** Combine a game + engine positions into the model the rest of the app uses. */
export function buildModel(game, positions) {
  const objs = replay(game.sans).slice(0, positions.length - 1);
  const moves = [];
  const inc = (game.clockIncrement || 0) * 100;
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const before = positions[i];
    const after = positions[i + 1];
    const sign = o.color === 'w' ? 1 : -1;
    const wpBefore = winPct(sign * before.cp);
    const wpAfter = winPct(sign * after.cp);
    const uci = o.from + o.to + (o.promotion || '');
    let loss = Math.max(0, wpBefore - wpAfter);
    if (uci === before.best) loss = 0;
    let cls = 'ok';
    if (loss >= 20) cls = 'blunder';
    else if (loss >= 10) cls = 'mistake';
    else if (loss >= 5) cls = 'inaccuracy';

    let clockBefore = null;
    let spent = null;
    if (game.clocks && game.clocks[i] != null && game.clockInitial != null) {
      clockBefore = i >= 2 ? game.clocks[i - 2] : game.clockInitial * 100;
      spent = Math.max(0, clockBefore - game.clocks[i] + (i >= 2 ? inc : 0));
    }
    const moveNo = Math.floor(i / 2) + 1;
    moves.push({
      ply: i,
      obj: o,
      san: o.san,
      uci,
      color: o.color,
      moveNo,
      label: `${moveNo}${o.color === 'w' ? '.' : '...'}${o.san}`,
      isUser: o.color === game.userColor,
      wpBefore,
      wpAfter,
      loss,
      cls,
      accuracy: Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)),
      phase: phaseOf(before.fen, moveNo),
      clockBefore,
      spent,
    });
  }
  const mine = moves.filter((m) => m.isUser);
  const theirs = moves.filter((m) => !m.isUser);
  const avg = (arr) => (arr.length ? arr.reduce((s, m) => s + m.accuracy, 0) / arr.length : 0);
  return {
    game,
    positions,
    moves,
    accuracy: avg(mine),
    oppAccuracy: avg(theirs),
    counts: {
      inaccuracy: mine.filter((m) => m.cls === 'inaccuracy').length,
      mistake: mine.filter((m) => m.cls === 'mistake').length,
      blunder: mine.filter((m) => m.cls === 'blunder').length,
    },
  };
}
