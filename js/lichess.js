// Fetch recent games from the public Lichess API (no login needed for public games).

export async function fetchGames(username, { max = 20, perf = '' } = {}) {
  const params = new URLSearchParams({
    max: String(max),
    clocks: 'true',
    opening: 'true',
    evals: 'false',
    finished: 'true',
  });
  if (perf) params.set('perfType', perf);
  else params.set('perfType', 'ultraBullet,bullet,blitz,rapid,classical,correspondence');

  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`,
    { headers: { Accept: 'application/x-ndjson' } }
  );
  if (res.status === 404) throw new Error(`Lichess has no player called "${username}".`);
  if (res.status === 429) throw new Error('Lichess is rate-limiting requests. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Lichess returned an error (${res.status}).`);

  const text = await res.text();
  const uname = username.toLowerCase();
  const games = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let g;
    try {
      g = JSON.parse(line);
    } catch {
      continue;
    }
    if (g.variant !== 'standard' || !g.moves) continue;
    const sans = g.moves.split(' ');
    if (sans.length < 8) continue; // aborted / too short to learn from
    const whiteName = g.players?.white?.user?.name || 'Anonymous';
    const blackName = g.players?.black?.user?.name || (g.players?.black?.aiLevel ? `Stockfish level ${g.players.black.aiLevel}` : 'Anonymous');
    const wName = g.players?.white?.user?.name || (g.players?.white?.aiLevel ? `Stockfish level ${g.players.white.aiLevel}` : whiteName);
    const userColor = (g.players?.white?.user?.id || '').toLowerCase() === uname ? 'w' : 'b';
    const result = !g.winner ? 'draw' : (g.winner === 'white') === (userColor === 'w') ? 'win' : 'loss';
    games.push({
      id: g.id,
      url: `https://lichess.org/${g.id}${userColor === 'b' ? '/black' : ''}`,
      createdAt: g.createdAt,
      speed: g.speed,
      rated: !!g.rated,
      status: g.status,
      white: wName,
      black: blackName,
      whiteRating: g.players?.white?.rating ?? null,
      blackRating: g.players?.black?.rating ?? null,
      userColor,
      opponent: userColor === 'w' ? blackName : wName,
      opponentRating: userColor === 'w' ? g.players?.black?.rating ?? null : g.players?.white?.rating ?? null,
      userRating: userColor === 'w' ? g.players?.white?.rating ?? null : g.players?.black?.rating ?? null,
      result,
      opening: g.opening?.name || 'Unknown opening',
      eco: g.opening?.eco || '',
      sans,
      clocks: g.clocks || null, // centiseconds remaining after each ply
      clockInitial: g.clock?.initial ?? null, // seconds
      clockIncrement: g.clock?.increment ?? 0,
    });
  }
  return games;
}
