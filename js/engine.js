// Thin promise wrapper around the Stockfish lite (single-threaded WASM) web worker.

const ENGINE_URL = 'engine/stockfish-19-lite-single.js';

export class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.onLine = null;
    this.worker.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : String(e.data ?? '');
      for (const line of text.split('\n')) if (line && this.onLine) this.onLine(line.trim());
    };
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(cmd, prefix) {
    return new Promise((resolve) => {
      this.onLine = (line) => {
        if (line.startsWith(prefix)) {
          this.onLine = null;
          resolve();
        }
      };
      this.send(cmd);
    });
  }

  async init() {
    await this.waitFor('uci', 'uciok');
    this.send('setoption name Hash value 32');
    this.send('setoption name UCI_ShowWDL value false');
    await this.waitFor('isready', 'readyok');
  }

  async newGame() {
    this.send('ucinewgame');
    await this.waitFor('isready', 'readyok');
  }

  /**
   * Analyse one position. Score is returned from the side-to-move's point of view.
   * @returns {Promise<{cp:number|null, mate:number|null, best:string|null, pv:string[], depth:number}>}
   */
  analyse(fen, depth, movetime) {
    return new Promise((resolve) => {
      let last = { cp: 0, mate: null, pv: [], depth: 0 };
      this.onLine = (line) => {
        if (line.startsWith('info') && line.includes(' pv ') && !line.includes('bound')) {
          const d = /\bdepth (\d+)/.exec(line);
          const cp = /\bscore cp (-?\d+)/.exec(line);
          const mate = /\bscore mate (-?\d+)/.exec(line);
          const pv = line.slice(line.indexOf(' pv ') + 4).split(' ');
          if (cp || mate) {
            last = {
              cp: cp ? Number(cp[1]) : null,
              mate: mate ? Number(mate[1]) : null,
              pv,
              depth: d ? Number(d[1]) : 0,
            };
          }
        } else if (line.startsWith('bestmove')) {
          this.onLine = null;
          const best = line.split(' ')[1];
          resolve({ ...last, best: best && best !== '(none)' ? best : null });
        }
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}${movetime ? ` movetime ${movetime}` : ''}`);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
