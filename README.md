# Choach

A chess coach that analyses your recent Lichess games in the browser and explains *why* your mistakes are mistakes, then looks for patterns across games.

## Run it

Requires Node.js. No install step: the engine and libraries are vendored.

```bash
node server.js
```

Then open http://localhost:4173 (on Windows, double-clicking `start.bat` does both). Enter a Lichess username and press **Analyse my games**.

## What it does

- Fetches your recent public games from the Lichess API.
- Runs Stockfish 19 lite (stockfish.js, single-threaded WASM) over every position, several workers in parallel. Analysis is cached in IndexedDB.
- **Game review:** for each inaccuracy, mistake and blunder, a plain-English explanation (hung piece, ignored threat, removed defender, fork, pin, skewer, discovered attack, mating net, missed tactic, king safety, opening principles), with the punishing line and the better line to step through on the board.
- **Coach report:** mistakes grouped by cause and ranked by cost, plus when they happen (rushed moves, time trouble, thrown wins, unpunished opponent errors), by phase and by opening.

Explanations are rule-based (`js/explain.js`), derived from the engine's lines and the board position. Nothing is uploaded anywhere.

## Layout

- `js/lichess.js` – game download
- `js/engine.js`, `js/analyze.js` – Stockfish worker and per-move judgements
- `js/explain.js` – the "why" for each move
- `js/patterns.js` – cross-game patterns
- `js/app.js`, `index.html`, `style.css` – interface
- `engine/`, `vendor/` – Stockfish lite, chess.js, chessground (copied from npm)

## Licences

Bundles Stockfish.js and Lichess chessground, both GPL-3.0, and chess.js (BSD-2-Clause). The project as a whole is therefore GPL-3.0.
