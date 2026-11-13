// The "why" engine. For each flagged move it compares two futures:
//   - the line the engine expects after the move you played (the punishment)
//   - the line the engine wanted instead
// and looks at what actually happens on the board in each: what gets captured,
// which piece was left hanging and why, forks / pins / skewers, mating nets,
// and a handful of positional rules of thumb. The result is plain-English text
// plus tags that the pattern finder aggregates across games.

import { Chess } from '../vendor/chess.js';
import { VAL } from './analyze.js';

export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const TAGS = {
  'hung-piece': 'Put a piece where it could be taken',
  'bad-exchange': 'Miscounted an exchange',
  'ignored-threat': 'Left an attacked piece hanging',
  'removed-defender': 'Moved away a defender',
  'uncovered-attack': 'Opened a line onto your own piece',
  'allowed-fork': 'Walked into a fork',
  'allowed-pin': 'Walked into a pin',
  'allowed-skewer': 'Walked into a skewer',
  'allowed-discovered': 'Allowed a discovered attack',
  'allowed-trap': 'Got a piece trapped',
  'allowed-promotion': 'Let a pawn promote',
  'lost-material': 'Allowed a tactic',
  'allowed-mate': 'Allowed checkmate',
  'missed-mate': 'Missed a checkmate',
  'missed-free-piece': 'Missed a free piece',
  'missed-capture': 'Missed a winning capture',
  'missed-fork': 'Missed a fork',
  'missed-pin': 'Missed a pin',
  'missed-skewer': 'Missed a skewer',
  'missed-discovered': 'Missed a discovered attack',
  'missed-trap': 'Missed trapping a piece',
  'missed-promotion': 'Missed a promotion',
  'missed-tactic': 'Missed a tactic',
  'king-safety': 'King safety',
  'opening-principles': 'Opening principles',
  'bad-trade': 'Unhelpful trade',
  positional: 'Positional slip',
  gambit: 'Gave up a pawn in the opening',
};

// ---------- small helpers ----------

const other = (c) => (c === 'w' ? 'b' : 'w');
const fileOf = (sq) => sq.charCodeAt(0) - 97;
const rankOf = (sq) => Number(sq[1]) - 1;
const sqName = (f, r) => String.fromCharCode(97 + f) + (r + 1);
const b = (s) => `<b>${s}</b>`;
const sanHtml = (s) => `<span class="san">${s}</span>`;
const an = (word) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

function listPieces(types) {
  const order = ['q', 'r', 'b', 'n', 'p'];
  const counts = {};
  for (const t of types) counts[t] = (counts[t] || 0) + 1;
  const parts = [];
  for (const t of order) {
    if (!counts[t]) continue;
    parts.push(counts[t] === 1 ? `a ${NAME[t]}` : `${counts[t] === 2 ? 'two' : counts[t]} ${NAME[t]}s`);
  }
  if (parts.length <= 1) return parts[0] || 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Squares strictly between two aligned squares (or null if not on a line). */
function between(a, c) {
  const df = fileOf(c) - fileOf(a);
  const dr = rankOf(c) - rankOf(a);
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return null;
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  const out = [];
  let f = fileOf(a) + sf;
  let r = rankOf(a) + sr;
  while (f !== fileOf(c) || r !== rankOf(c)) {
    out.push(sqName(f, r));
    f += sf;
    r += sr;
  }
  return out;
}

export function playLine(fen, ucis, max = 14) {
  const c = new Chess(fen);
  const out = [];
  for (const u of (ucis || []).slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
    } catch {
      break;
    }
  }
  return out;
}

function nullFen(fen) {
  const p = fen.split(' ');
  p[1] = other(p[1]);
  p[3] = '-';
  return p.join(' ');
}

/** Could `move` already have been played if the mover had simply passed? */
function wasAlreadyPossible(preChess, preFen, move) {
  if (preChess.inCheck()) return false;
  try {
    const c = new Chess(nullFen(preFen));
    const m = c.move({ from: move.from, to: move.to, promotion: move.promotion });
    return !!m && (m.captured || null) === (move.captured || null);
  } catch {
    return false;
  }
}

/** Net material of consecutive captures on one square, for the side making line[idx]. */
function seqNet(line, idx) {
  const sq = line[idx].to;
  const side = line[idx].color;
  let net = 0;
  for (let i = idx; i < line.length && line[i].to === sq && line[i].captured; i++) {
    net += (line[i].color === side ? 1 : -1) * VAL[line[i].captured];
  }
  return net;
}

/** Material that changes hands along a line, from `user`'s point of view. */
function swing(line, user) {
  let cut = line.length;
  for (let i = 6; i < line.length; i++) {
    if (!line[i].captured && !line[i].san.includes('+') && !line[i - 1].san.includes('+')) {
      cut = i;
      break;
    }
  }
  let delta = 0;
  const userLost = [];
  const oppLost = [];
  let promoUser = false;
  let promoOpp = false;
  for (let i = 0; i < cut; i++) {
    const m = line[i];
    const mine = m.color === user;
    if (m.captured) {
      (mine ? oppLost : userLost).push(m.captured);
      delta += (mine ? 1 : -1) * VAL[m.captured];
    }
    if (m.promotion) {
      delta += (mine ? 1 : -1) * (VAL[m.promotion] - 1);
      if (mine) promoUser = true;
      else promoOpp = true;
    }
  }
  // The engine's line stopped mid-exchange: assume the obvious recapture.
  const last = line[cut - 1];
  if (last && last.captured && cut === line.length) {
    const c = new Chess(last.after);
    if (c.attackers(last.to, c.turn()).length) {
      const t = last.promotion || last.piece;
      (last.color === user ? userLost : oppLost).push(t);
      delta += (last.color === user ? -1 : 1) * VAL[t];
    }
  }
  // Cancel like-for-like trades so the summary reads cleanly.
  const u = [...userLost];
  const o = [...oppLost];
  for (let i = u.length - 1; i >= 0; i--) {
    const j = o.indexOf(u[i]);
    if (j >= 0) {
      o.splice(j, 1);
      u.splice(i, 1);
    }
  }
  return { delta, userLost: u, oppLost: o, promoUser, promoOpp, cut };
}

function netPhrase(sw) {
  const promo = sw.promoOpp ? ' and they get a new queen' : '';
  if (sw.userLost.length && sw.oppLost.length) {
    return `you give up ${listPieces(sw.userLost)} for ${listPieces(sw.oppLost)}${promo}`;
  }
  if (sw.userLost.length) return `you lose ${listPieces(sw.userLost)}${promo}`;
  if (sw.promoOpp) return 'their pawn promotes';
  if (sw.oppLost.length) return `you win ${listPieces(sw.oppLost)}`;
  return 'material stays level';
}

/** Which of `targets` (squares holding victim pieces) get captured later in the line? */
function lostTargets(targets, later, attackerColor, maxPlies = 6, mustStay = false) {
  const where = new Map(targets.map((t) => [t, t]));
  const lost = [];
  for (const m of later.slice(0, maxPlies)) {
    if (m.color === attackerColor) {
      for (const [orig, cur] of where) {
        if (m.captured && m.to === cur) {
          lost.push(orig);
          where.delete(orig);
        }
      }
    } else {
      for (const [orig, cur] of where) {
        if (m.from !== cur) continue;
        if (mustStay) where.delete(orig);
        else where.set(orig, m.to);
      }
    }
  }
  return lost;
}

function piecesOf(chess, color) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && p.color === color) out.push(p);
  return out;
}

function hasSafeSquare(post, sq, attackerColor) {
  const piece = post.get(sq);
  if (!piece) return true;
  let moves;
  try {
    moves = post.moves({ square: sq, verbose: true });
  } catch {
    return true;
  }
  for (const m of moves) {
    if (m.captured && VAL[m.captured] >= VAL[piece.type]) return true;
    const c = new Chess(m.after);
    if (!c.attackers(m.to, attackerColor).length) return true;
  }
  return false;
}

const RAYS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
RAYS.q = [...RAYS.b, ...RAYS.r];

/**
 * What does line[idx] (the "blow") do tactically to `victim`?
 * Only reports a motif if the line then really cashes it in.
 */
function findMotif(line, idx, victim) {
  const blow = line[idx];
  const attacker = blow.color;
  const pre = new Chess(blow.before);
  const post = new Chess(blow.after);
  const later = line.slice(idx + 1);
  const type = blow.promotion || blow.piece;
  const victims = piecesOf(post, victim);

  // Fork / double attack
  const hit = [];
  for (const p of victims) {
    if (!post.attackers(p.square, attacker).includes(blow.to)) continue;
    if (p.type === 'k' || VAL[p.type] > VAL[type] || (p.type !== 'p' && !post.attackers(p.square, victim).length)) {
      hit.push(p);
    }
  }
  const nonKing = hit.filter((p) => p.type !== 'k').map((p) => p.square);
  if (hit.length >= 2) {
    const lost = lostTargets(nonKing, later, attacker);
    if (lost.length) return { kind: 'fork', by: type, sq: blow.to, targets: hit, lost };
  }

  // Skewer / pin along a line
  if (RAYS[type]) {
    for (const [df, dr] of RAYS[type]) {
      const seen = [];
      let f = fileOf(blow.to) + df;
      let r = rankOf(blow.to) + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8 && seen.length < 2) {
        const p = post.get(sqName(f, r));
        if (p) seen.push({ ...p, square: sqName(f, r) });
        f += df;
        r += dr;
      }
      if (seen.length < 2 || seen[0].color !== victim || seen[1].color !== victim) continue;
      const [x, y] = seen;
      if (y.type === 'k' && x.type !== 'k') {
        if (lostTargets([x.square], later, attacker, 6, true).length) return { kind: 'pin', by: type, sq: blow.to, front: x, back: y };
      } else if (x.type === 'k' || VAL[x.type] > VAL[y.type]) {
        if (lostTargets([y.square], later, attacker).length || (x.type !== 'k' && lostTargets([x.square], later, attacker).length)) {
          return { kind: 'skewer', by: type, sq: blow.to, front: x, back: y };
        }
      } else if (VAL[y.type] > VAL[x.type] && lostTargets([x.square], later, attacker, 6, true).length) {
        return { kind: 'pin', by: type, sq: blow.to, front: x, back: y };
      }
    }
  }

  // Discovered attack
  for (const p of victims) {
    if (p.type !== 'k' && VAL[p.type] < 3) continue;
    const before = pre.attackers(p.square, attacker);
    const fresh = post.attackers(p.square, attacker).filter((s) => s !== blow.to && !before.includes(s));
    for (const s of fresh) {
      const btw = between(s, p.square);
      if (btw && btw.includes(blow.from) && (p.type === 'k' || lostTargets([p.square], later, attacker).length)) {
        return { kind: 'discovered', mover: type, from: s, unmasked: post.get(s)?.type, target: p };
      }
    }
  }

  // A single attack that can't be met (often a trapped piece)
  if (!blow.captured) {
    for (const p of hit) {
      if (p.type === 'k') continue;
      if (lostTargets([p.square], later, attacker).length) {
        return { kind: 'attack', by: type, sq: blow.to, target: p, trapped: !hasSafeSquare(post, p.square, attacker) };
      }
    }
  }
  return null;
}

function motifText(m, blowSan, victimIsUser) {
  const their = victimIsUser ? 'your' : 'their';
  const att = victimIsUser ? 'their' : 'your';
  const tgt = (p) => (p.type === 'k' ? `${their} king` : `${their} ${NAME[p.type]} on ${b(p.square)}`);
  const s = sanHtml(blowSan);
  switch (m.kind) {
    case 'fork': {
      const names = m.targets.map(tgt);
      const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `${s} is a <b>fork</b>: ${att} ${NAME[m.by]} lands on ${b(m.sq)} and attacks ${list} at the same time. Only one of them can be saved.`;
    }
    case 'pin':
      return `${s} is a <b>pin</b>: ${att} ${NAME[m.by]} attacks ${tgt(m.front)}, which can't get out of the way because ${tgt(m.back)} is right behind it. The pinned piece is lost.`;
    case 'skewer':
      return `${s} is a <b>skewer</b>: ${att} ${NAME[m.by]} attacks ${tgt(m.front)}, and once that moves out of the line, ${tgt(m.back)} behind it falls.`;
    case 'discovered':
      return `${s} is a <b>discovered attack</b>: moving the ${NAME[m.mover]} out of the way unmasks ${att} ${NAME[m.unmasked] || 'piece'} on ${b(m.from)} against ${tgt(m.target)}, while the ${NAME[m.mover]} makes a second threat of its own.`;
    case 'attack':
      return m.trapped
        ? `${s} attacks ${tgt(m.target)}, and it is <b>trapped</b>: every square it could run to is covered.`
        : `${s} attacks ${tgt(m.target)}, and there's no way to save it without giving up something else.`;
    default:
      return '';
  }
}

/** A short phrase for what a move is trying to do. */
function ideaOf(move) {
  const pre = new Chess(move.before);
  const post = new Chess(move.after);
  const me = move.color;
  const opp = other(me);
  const type = move.promotion || move.piece;
  if (move.san.startsWith('O-O')) return 'tucking the king away and connecting the rooks';
  if (move.promotion) return 'promoting the pawn';
  if (move.captured) return `taking the ${NAME[move.captured]} on ${move.to}`;
  const bits = [];
  if (move.san.includes('+')) bits.push('giving check');
  // escaping an attack
  const attackers = pre.attackers(move.from, opp);
  if (type !== 'p' && type !== 'k' && attackers.length) {
    const cheapest = Math.min(...attackers.map((s) => VAL[pre.get(s).type]));
    if (cheapest < VAL[type] || !pre.attackers(move.from, me).length) bits.push(`moving the attacked ${NAME[type]} to safety`);
  }
  // creating a threat
  for (const p of piecesOf(post, opp)) {
    if (p.type === 'k') continue;
    if (!post.attackers(p.square, me).includes(move.to)) continue;
    if (VAL[p.type] > VAL[type] || (p.type !== 'p' && !post.attackers(p.square, opp).length)) {
      bits.push(`attacking the ${NAME[p.type]} on ${p.square}`);
      break;
    }
  }
  if (!bits.length) {
    const home = me === 'w' ? '1' : '8';
    if ((type === 'n' || type === 'b') && move.from[1] === home) bits.push(`developing the ${NAME[type]}`);
    else if (type === 'r') {
      const f = move.to[0];
      const pawnsOnFile = piecesOf(post, me).concat(piecesOf(post, opp)).filter((p) => p.type === 'p' && p.square[0] === f);
      if (!pawnsOnFile.length) bits.push(`putting the rook on the open ${f}-file`);
      else if (!pawnsOnFile.some((p) => p.color === me)) bits.push(`putting the rook on the half-open ${f}-file`);
    } else if (type === 'p' && 'cdef'.includes(move.to[0]) && '45'.includes(move.to[1])) {
      bits.push('fighting for the centre');
    } else if (type === 'p') {
      const r = Number(move.to[1]);
      if ((me === 'w' && r >= 6) || (me === 'b' && r <= 3)) bits.push('pushing the passed pawn');
    }
  }
  return bits.join(' and ');
}

function standing(wp) {
  if (wp >= 85) return 'winning';
  if (wp >= 65) return 'clearly better';
  if (wp >= 55) return 'slightly better';
  if (wp > 45) return 'about equal';
  if (wp > 35) return 'slightly worse';
  if (wp > 15) return 'clearly worse';
  return 'losing';
}

function fmtClock(cs) {
  const s = Math.max(0, Math.round(cs / 100));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- the main explainer ----------

export function explainMove(model, ply) {
  const { game, positions, moves } = model;
  const mv = moves[ply];
  const M = mv.obj;
  const P = positions[ply];
  const Q = positions[ply + 1];
  const user = mv.color;
  const opp = other(user);
  const sign = user === 'w' ? 1 : -1;
  const Pc = new Chess(P.fen);
  const Qc = new Chess(Q.fen);
  const prev = ply > 0 ? moves[ply - 1] : null;

  const refTail = Q.over ? [] : playLine(Q.fen, Q.pv);
  const playedLine = [M, ...refTail];
  const bestLine = playLine(P.fen, P.pv);
  const R = refTail[0] || null;
  const B = bestLine[0] || null;
  const sp = swing(playedLine, user);
  const sb = swing(bestLine, user);
  const mateBefore = P.mate != null ? sign * P.mate : null;
  const mateAfter = Q.mate != null ? sign * Q.mate : null;

  const tags = [];
  const why = [];
  let better = '';
  let origin = null; // 'threat' = you missed something already on the board; 'self' = your move created it
  let lostPiece = null;
  const movedType = M.promotion || M.piece;
  const Rs = R ? sanHtml(R.san) : '';
  const Ms = sanHtml(M.san);
  const Bs = B ? sanHtml(B.san) : '';

  const prevCreated = (fromSq) => {
    if (!prev) return '';
    if (prev.obj.to === fromSq) return ` Their last move, ${sanHtml(prev.san)}, is what created that threat.`;
    return '';
  };

  if (mateAfter != null && mateAfter < 0) {
    // ---- A. allows mate ----
    tags.push('allowed-mate');
    const n = Math.abs(mateAfter);
    const end = refTail.length ? new Chess(refTail[refTail.length - 1].after) : null;
    const finisher = refTail[refTail.length - 1];
    let backRank = false;
    if (end && end.isCheckmate() && finisher) {
      const king = piecesOf(end, user).find((p) => p.type === 'k');
      const home = user === 'w' ? '1' : '8';
      const fType = finisher.promotion || finisher.piece;
      backRank = king.square[1] === home && finisher.to[1] === home && (fType === 'r' || fType === 'q');
    }
    why.push(
      n === 1
        ? `This allows checkmate in one: ${Rs} ends the game on the spot.`
        : `This lets your opponent force checkmate in ${n}, starting with ${Rs}.`
    );
    if (backRank) {
      tags.push('back-rank');
      why.push(`It's a <b>back-rank mate</b>: your king is boxed in on the back row by its own pawns, so a rook or queen landing there is fatal. A spare tempo to give the king an escape square (a "luft" pawn move) or keeping a piece guarding the back rank prevents it.`);
    }
    if (n <= 3 && R && wasAlreadyPossible(Pc, P.fen, R)) {
      origin = 'threat';
      why.push(`The threat of ${Rs} was already on the board before you moved, and ${Ms} didn't stop it. The question to ask after every opponent move is "what is that threatening?"`);
    } else if (n <= 3) {
      origin = 'self';
      why.push(`Before ${Ms} this wasn't possible: it's your move that opened the door. Step through the line below to see the mating pattern, because these recur.`);
    } else {
      const promo = refTail.find((m) => m.color === opp && m.promotion);
      if (promo) why.push(`The practical problem is simpler than the mate count suggests: their pawn promotes with ${sanHtml(promo.san)} and the new queen decides the game.`);
      else why.push(`It's a long forced sequence rather than something you could be expected to see at a glance; the line below shows how it starts.`);
    }
    if (B) better = `${Bs}${ideaOf(B) ? ` (${ideaOf(B)})` : ''} was the way to stay in the game${mateBefore != null && mateBefore < 0 ? ' a little longer' : `, leaving you ${standing(mv.wpBefore)}`}.`;
  } else if (mateBefore != null && mateBefore > 0 && !(mateAfter != null && mateAfter > 0)) {
    // ---- B. missed mate ----
    tags.push('missed-mate');
    why.push(
      mateBefore === 1
        ? `You had checkmate in one here: ${Bs} ends the game.`
        : `You had a forced checkmate in ${mateBefore}, starting with ${Bs}.`
    );
    why.push(`After ${Ms} you're ${standing(mv.wpAfter)}, but the forced win is gone. When the enemy king is short of squares, look at <b>every check</b> before anything else.`);
    better = `${Bs} starts the mating sequence. Step through it below.`;
  } else if (R && sp.delta < 0 && sb.delta - sp.delta >= 1) {
    // ---- C. the move loses material ----
    const direct = R.captured ? seqNet(playedLine, 1) - (R.to === M.to && M.captured ? VAL[M.captured] : 0) : 0;
    const motif = findMotif(playedLine, 1, user);
    const motif2 = !motif && playedLine[3] ? findMotif(playedLine, 3, user) : null;
    const need = Math.min(2, -sp.delta);
    if (mv.moveNo <= 8 && M.piece === 'p' && !M.captured && sp.delta === -1 && sp.userLost.length === 1 && mv.cls !== 'blunder') {
      tags.push('gambit');
      why.push(`This gives up a pawn: ${Rs} wins it and the engine doesn't see enough compensation. If it was a deliberate gambit for quick development, that's a legitimate practical choice and you can ignore this one; if you didn't mean to give the pawn away, it's the same "what attacks this square?" check as anywhere else.`);
    } else if (R.captured && direct >= need && !(motif && motif.kind === 'fork' && direct < 3)) {
      const S = R.to;
      lostPiece = R.captured;
      const attackerDesc = `their ${NAME[R.piece]} on ${b(R.from)}`;
      if (S === M.to && M.captured) {
        tags.push('bad-exchange');
        origin = 'self';
        why.push(`You took the ${NAME[M.captured]} on ${b(S)} with your ${NAME[M.piece]}, but that ${NAME[M.captured]} was protected. ${Rs} takes back, and you've swapped ${an(NAME[movedType])} (worth ${VAL[movedType]}) for ${an(NAME[M.captured])} (worth ${VAL[M.captured]}).`);
        why.push(`Before any capture, count what's defending the piece you're taking, and ask whether you'd be happy with the trade if they recapture.`);
      } else if (S === M.to) {
        tags.push('hung-piece');
        origin = 'self';
        lostPiece = movedType;
        const att = Qc.attackers(S, opp).length;
        const def = Qc.attackers(S, user).length;
        let detail;
        if (!def) detail = `Nothing of yours defends ${b(S)}, so the ${NAME[movedType]} is simply lost.`;
        else if (VAL[R.piece] < VAL[movedType]) detail = `It is defended, but that doesn't help: they're happy to give ${an(NAME[R.piece])} (worth ${VAL[R.piece]}) for your ${NAME[movedType]} (worth ${VAL[movedType]}).`;
        else detail = `It looks defended, but count it up: they attack ${b(S)} ${att} time${att === 1 ? '' : 's'} and you defend it ${def} time${def === 1 ? '' : 's'}, so you come out behind when the captures finish.`;
        why.push(`You moved your ${NAME[movedType]} to ${b(S)}, a square where ${attackerDesc} can take it. ${detail}`);
      } else {
        const wasAttacked = Pc.attackers(S, opp).includes(R.from);
        const defBefore = Pc.attackers(S, user);
        const defAfter = Qc.attackers(S, user);
        const mine = `your ${NAME[R.captured]} on ${b(S)}`;
        const btw = between(R.from, S);
        if (!wasAttacked && btw && btw.includes(M.from)) {
          tags.push('uncovered-attack');
          origin = 'self';
          why.push(`Your ${NAME[M.piece]} on ${b(M.from)} was standing between ${attackerDesc} and ${mine}. Moving it opened that line, and ${Rs} wins the ${NAME[R.captured]}.`);
          why.push(`A piece that's shielding something more valuable isn't really free to move. Before moving, look along the lines it's blocking.`);
        } else if (wasAttacked && defBefore.includes(M.from) && defAfter.length < defBefore.length) {
          tags.push('removed-defender');
          origin = 'self';
          why.push(`Your ${NAME[M.piece]} on ${b(M.from)} was guarding ${mine}. When it moved away with ${Ms}, the ${NAME[R.captured]} lost its protection and ${Rs} picks it up.`);
          why.push(`Before you move a piece, check what it's currently doing: if it's the only thing defending something, it has a job and can't leave.`);
        } else if (wasAttacked) {
          tags.push('ignored-threat');
          origin = 'threat';
          const defended = defBefore.length ? ' and not adequately defended' : ' and undefended';
          why.push(`${mine[0].toUpperCase() + mine.slice(1)} was already attacked by ${attackerDesc}${defended}.${prevCreated(R.from)} ${Ms} did nothing about it, so ${Rs} just takes.`);
          why.push(`It needed one of three things: move it, defend it, or deal with the attacker. Before choosing your move, ask what their last move threatens.`);
        } else {
          tags.push('lost-material');
          origin = 'self';
          why.push(`${Ms} allows ${Rs}, winning ${mine}. That capture wasn't available before your move.`);
        }
      }
    } else if (motif) {
      const key = { fork: 'allowed-fork', pin: 'allowed-pin', skewer: 'allowed-skewer', discovered: 'allowed-discovered', attack: motif.trapped ? 'allowed-trap' : 'lost-material' }[motif.kind];
      tags.push(key);
      why.push(`${motifText(motif, R.san, true)}`);
      const targets = motif.targets ? motif.targets.map((p) => p.square) : [motif.target?.square, motif.front?.square, motif.back?.square].filter(Boolean);
      const guarded = Pc.attackers(R.to, user).includes(M.from) && !Qc.attackers(R.to, user).includes(M.to);
      if (targets.includes(M.to)) {
        origin = 'self';
        why.push(`It only works because of where ${Ms} put your ${NAME[movedType]}: on ${b(M.to)} it becomes one of the targets.`);
      } else if (guarded) {
        origin = 'self';
        why.push(`Your ${NAME[M.piece]} on ${b(M.from)} had been covering ${b(R.to)}. Once it left, that square became available.`);
      } else if (wasAlreadyPossible(Pc, P.fen, R)) {
        origin = 'threat';
        why.push(`This idea was already available before your move, and ${Ms} didn't prevent it.${prevCreated(R.from)}`);
      } else {
        origin = 'self';
        why.push(`It wasn't possible before ${Ms}; your move is what set it up.`);
      }
      const first = motif.lost?.[0] || motif.target?.square || motif.front?.square;
      lostPiece = first ? Qc.get(first)?.type || null : null;
    } else if (motif2) {
      const key = { fork: 'allowed-fork', pin: 'allowed-pin', skewer: 'allowed-skewer', discovered: 'allowed-discovered', attack: motif2.trapped ? 'allowed-trap' : 'lost-material' }[motif2.kind];
      tags.push(key);
      origin = 'self';
      why.push(`${Ms} allows a two-move combination. ${Rs} comes first${R.captured && seqNet(playedLine, 1) < 0 ? ' (it looks like it just gives material away)' : ''}, and after ${sanHtml(playedLine[2].san)} the point appears: ${motifText(motif2, playedLine[3].san, true)}`);
      why.push(`To catch these, look at the opponent's forcing moves (checks and captures, even ones that seem to lose material) and ask what they would have <i>next</i>.`);
    } else if (sp.promoOpp) {
      tags.push('allowed-promotion');
      why.push(`${Ms} lets their pawn run through and promote. Follow the line below: you can't catch or block it in time.`);
    } else {
      tags.push('lost-material');
      why.push(`${Ms} loses material by force. It isn't a single obvious capture: after ${Rs} the threats pile up and something has to give. Step through the line below to see it happen.`);
    }
    why.push(`Net result of the line: ${netPhrase(sp)}.`);

    // What the engine's move does about it
    if (B) {
      let how = '';
      const lostSq = playedLine.slice(1).find((m) => m.color === opp && m.captured)?.to;
      if (B.to === R.from && B.captured) how = `removes the attacker by taking on ${b(B.to)}`;
      else if (lostSq && B.from === lostSq) how = `moves the threatened ${NAME[B.piece]} out of danger`;
      else if (lostSq && lostSq !== M.to) {
        const after = new Chess(B.after);
        if (after.attackers(lostSq, user).length > Pc.attackers(lostSq, user).length) how = `adds a defender to ${b(lostSq)}`;
        else if ((between(R.from, lostSq) || []).includes(B.to)) how = `blocks the attack`;
      }
      if (!how) how = ideaOf(B) ? `${ideaOf(B)}` : 'avoids all of this';
      else if (B.san.includes('+')) how += ' with check';
      better = `${Bs} ${/^(removes|moves|adds|blocks|avoids)/.test(how) ? how : `(${how})`} and leaves you ${standing(mv.wpBefore)}.`;
    }
  } else if (B && sb.delta > 0 && sb.delta - sp.delta >= 1) {
    // ---- D. missed a chance to win material ----
    origin = 'missed';
    const direct = B.captured ? seqNet(bestLine, 0) : 0;
    const motif = findMotif(bestLine, 0, opp);
    if (B.captured && direct >= Math.min(2, sb.delta) && !(motif && motif.kind === 'fork' && direct < 3)) {
      const defenders = Pc.attackers(B.to, opp);
      const target = `Their ${NAME[B.captured]} on ${b(B.to)}`;
      if (!defenders.length) {
        tags.push('missed-free-piece');
        why.push(`${target} wasn't defended by anything. ${Bs} simply wins it for free.`);
      } else if (VAL[B.piece] < VAL[B.captured]) {
        tags.push('missed-capture');
        why.push(`${target} could be taken by your ${NAME[B.piece]}. Even though it's defended, giving ${an(NAME[B.piece])} (worth ${VAL[B.piece]}) for ${an(NAME[B.captured])} (worth ${VAL[B.captured]}) is a clear win of material.`);
      } else {
        tags.push('missed-capture');
        const att = Pc.attackers(B.to, user).length;
        why.push(`${target} was attacked ${att} time${att === 1 ? '' : 's'} by you and defended only ${defenders.length} time${defenders.length === 1 ? '' : 's'}. ${Bs} wins material once the captures are finished.`);
      }
      if (prev && prev.loss >= 10) why.push(`Your opponent's last move, ${sanHtml(prev.san)}, was the error that left it there. After every opponent move, check what it stopped defending.`);
    } else if (motif) {
      const key = { fork: 'missed-fork', pin: 'missed-pin', skewer: 'missed-skewer', discovered: 'missed-discovered', attack: motif.trapped ? 'missed-trap' : 'missed-tactic' }[motif.kind];
      tags.push(key);
      why.push(`You had a tactic here. ${motifText(motif, B.san, false)}`);
    } else if (bestLine[2] && findMotif(bestLine, 2, opp)) {
      const m2 = findMotif(bestLine, 2, opp);
      const key = { fork: 'missed-fork', pin: 'missed-pin', skewer: 'missed-skewer', discovered: 'missed-discovered', attack: m2.trapped ? 'missed-trap' : 'missed-tactic' }[m2.kind];
      tags.push(key);
      why.push(`You had a two-move combination. ${Bs} comes first, and after ${sanHtml(bestLine[1].san)} the point appears: ${motifText(m2, bestLine[2].san, false)}`);
    } else if (sb.promoUser) {
      tags.push('missed-promotion');
      why.push(`Your pawn could have gone through: ${Bs} leads to promotion and they can't stop it. Step through the better line below.`);
    } else {
      tags.push('missed-tactic');
      if (sb.delta - sp.delta < 2) why.push(`${Bs} would have won a pawn; the better line below shows how. It's a small gain, but these add up.`);
      else why.push(`There was a forcing sequence starting with ${Bs} that wins material. It's not a one-move shot, so step through the better line below to see how the threats combine.`);
    }
    why.push(`In the better line ${netPhrase(sb)}. After ${Ms} instead, ${sp.delta < 0 ? netPhrase(sp) : 'the chance is gone'}.`);
    better = `${Bs} was the move.`;
  } else {
    // ---- E. nothing is won or lost immediately: positional / king safety ----
    const castlingRights = P.fen.split(' ')[2];
    const canCastle = user === 'w' ? /[KQ]/.test(castlingRights) : /[kq]/.test(castlingRights);
    const home = user === 'w' ? '1' : '8';
    const mine = piecesOf(Pc, user);
    const king = mine.find((p) => p.type === 'k');
    const minorsAtHome = mine.filter((p) => (p.type === 'n' || p.type === 'b') && p.square[1] === home).length;
    const oppChecks = refTail.slice(0, 8).filter((m) => m.color === opp && m.san.includes('+')).length;
    const bDevelops = B && (B.san.startsWith('O-O') || ((B.piece === 'n' || B.piece === 'b') && B.from[1] === home));
    const mDevelops = M.san.startsWith('O-O') || ((M.piece === 'n' || M.piece === 'b') && M.from[1] === home);
    let balance = 0;
    for (const p of mine) balance += VAL[p.type];
    for (const p of piecesOf(Pc, opp)) balance -= VAL[p.type];

    const theirRun = refTail.slice(0, 8).find((m) => m.color === opp && (m.promotion || (m.piece === 'p' && m.to[1] === (opp === 'w' ? '7' : '2'))));
    const bForcing = B && (B.captured || B.san.includes('+')) && !(M.captured || M.san.includes('+'));
    if (theirRun && mv.phase === 'endgame') {
      tags.push('allowed-promotion');
      why.push(`${Ms} lets their pawn run: in the line below it reaches ${b(theirRun.to)} and you can't stop it promoting. In pawn races, count the moves for both sides before committing your king or pieces elsewhere.`);
    } else if (M.piece === 'k' && !M.san.startsWith('O-O') && canCastle && !Pc.inCheck()) {
      tags.push('king-safety');
      why.push(`Moving the king gives up the right to castle for the rest of the game. Your king is now stuck nearer the centre and the rook on that side is harder to bring into play.`);
    } else if (B && B.san.startsWith('O-O') && !M.san.startsWith('O-O')) {
      tags.push('king-safety');
      why.push(`The engine wanted you to castle now. Your king is still in the middle, where opening lines lead straight to it, and ${Ms} spends a move on something less urgent.`);
    } else if (bForcing && mv.loss >= 10) {
      tags.push('missed-tactic');
      origin = 'missed';
      const bIdea = ideaOf(B);
      why.push(`You had a forcing move here and played a quiet one. ${Bs}${bIdea ? ` (${bIdea})` : ''} starts a sequence the opponent has to respond to, and at the end of it you are ${standing(mv.wpBefore)}; after ${Ms} you are ${standing(mv.wpAfter)}.`);
      why.push(`The gain isn't a simple "win a piece in two moves", so step through the better line below. The habit that finds these: look at every check and every capture before settling on a quiet move.`);
    } else if (oppChecks >= 2 && mv.phase !== 'endgame') {
      tags.push('king-safety');
      why.push(`No material drops straight away, but after ${Rs} your opponent gets a direct attack going against your king and the engine thinks it can't be held. Step through the line below to see how it builds.`);
    } else if (M.piece === 'p' && king && king.square[1] === home && Math.abs(fileOf(M.from) - fileOf(king.square)) <= 1 && !canCastle && mv.phase !== 'endgame') {
      tags.push('king-safety');
      why.push(`That pawn was part of the shelter in front of your king. Pushing it leaves holes around the king that can't be repaired, because pawns don't move backwards.${R ? ` The engine's reply is ${Rs}, ${ideaOf(R) || 'starting to probe those weaknesses'}.` : ''}`);
    } else if (mv.moveNo <= 10 && M.piece === 'q' && B && B.piece !== 'q') {
      tags.push('opening-principles');
      why.push(`Bringing the queen out this early usually backfires: the opponent develops pieces with gain of time by attacking her, while your other pieces stay at home.${minorsAtHome ? ` You still have ${minorsAtHome} minor piece${minorsAtHome === 1 ? '' : 's'} on the back row.` : ''}`);
    } else if (mv.moveNo <= 12 && bDevelops && !mDevelops && (minorsAtHome >= 2 || canCastle)) {
      tags.push('opening-principles');
      const what = M.piece === 'p' ? 'another pawn move' : (M.piece === 'n' || M.piece === 'b') ? `moving the ${NAME[M.piece]} a second time` : `a ${NAME[M.piece]} move`;
      why.push(`This is ${what} while you're behind in development${minorsAtHome ? ` (${minorsAtHome} minor piece${minorsAtHome === 1 ? '' : 's'} still on the back row)` : ''}. In the opening, each move should ideally bring a new piece out or get the king castled; the engine preferred ${Bs}.`);
    } else if (balance <= -3 && M.captured && R && R.captured && R.to === M.to && Math.abs(sp.delta) < 1) {
      tags.push('bad-trade');
      why.push(`You're behind in material, and this is an even trade. Swapping pieces when you're behind makes the opponent's extra material count for more and removes the pieces you'd need to create counterplay. Keep pieces on and look for complications instead.`);
    } else {
      tags.push('positional');
      const bIdea = B ? ideaOf(B) : '';
      const rIdea = R ? ideaOf(R) : '';
      why.push(`This one is positional rather than tactical: nothing is lost immediately, but the engine rates your position noticeably worse afterwards (${standing(mv.wpBefore)} before, ${standing(mv.wpAfter)} after).`);
      if (R) why.push(`After ${Ms}, their best reply is ${Rs}${rIdea ? `, ${rIdea}` : ''}.`);
      if (B && bIdea) why.push(`The engine preferred ${Bs}, ${bIdea}.`);
    }
    if (B && !better) better = `${Bs}${ideaOf(B) ? ` (${ideaOf(B)})` : ''} would have kept you ${standing(mv.wpBefore)}.`;
  }

  // ---------- context that applies whatever the mistake was ----------
  const context = [];
  if (prev && prev.loss >= 10 && mv.wpBefore >= 55 && origin !== 'threat') {
    tags.push('missed-punish');
    if (!tags.some((t) => t.startsWith('missed-') && t !== 'missed-punish')) {
      context.push(`Your opponent's previous move (${sanHtml(prev.san)}) was a mistake, so this was a moment to slow down and look for the punishment.`);
    }
  }
  if (mv.wpBefore >= 75 && mv.wpAfter < 60) {
    tags.push('threw-win');
    context.push(`You were ${standing(mv.wpBefore)} before this move and ${standing(mv.wpAfter)} after it.`);
  }
  if (mv.clockBefore != null && game.clockInitial) {
    const initial = game.clockInitial * 100;
    const budget = initial / 40 + (game.clockIncrement || 0) * 100;
    const low = mv.clockBefore < Math.max(2000, initial * 0.1);
    if (low) {
      tags.push('time-trouble');
      context.push(`You had only ${fmtClock(mv.clockBefore)} left on the clock here.`);
    } else if (mv.spent != null && mv.spent < budget * 0.3 && mv.ply > 12) {
      tags.push('rushed');
      context.push(`You played this in about ${Math.max(1, Math.round(mv.spent / 100))}s with ${fmtClock(mv.clockBefore)} still on the clock. There was time to check it.`);
    } else if (mv.spent != null && mv.spent > budget * 3) {
      tags.push('long-think');
      context.push(`You spent ${fmtClock(mv.spent)} on this move, so it wasn't a rushed decision; the idea itself was the problem.`);
    }
  }
  if (origin === 'threat') tags.push('origin-threat');
  if (origin === 'self') tags.push('origin-self');

  const primary = tags[0];
  return {
    ply,
    primary,
    title: TAGS[primary] || 'Mistake',
    tags,
    why,
    better,
    context,
    lostPiece,
    loss: mv.loss,
    cls: mv.cls,
    phase: mv.phase,
    refLine: { fen: Q.fen, moves: refTail.slice(0, Math.max(1, sp.cut - 1)) },
    bestLine: { fen: P.fen, moves: bestLine.slice(0, Math.max(1, sb.cut)) },
  };
}

/** Explain every flagged move the user made in one game. */
export function explainGame(model) {
  const out = {};
  for (const mv of model.moves) {
    if (!mv.isUser || mv.cls === 'ok') continue;
    try {
      out[mv.ply] = explainMove(model, mv.ply);
    } catch (err) {
      console.warn('explain failed', model.game.id, mv.ply, err);
    }
  }
  return out;
}
