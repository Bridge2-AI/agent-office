import type { Adopted, Pty, PtyExit } from '../ptys.js';

/**
 * A worker's terminal on a node, from before the office restarted. The office can't hear from its
 * nodes until it's open, so the worker gets this at once and it's joined to the real terminal
 * when the node is back (bind), or lost if the node doesn't come back in time.
 */
export class PendingPty implements Pty {
  pid = 0;
  private inner?: Pty;
  private dataCbs: ((data: string) => void)[] = [];
  private exitCbs: ((e: PtyExit) => void)[] = [];
  private exited?: PtyExit;
  private timer: NodeJS.Timeout;
  private size = { cols: 100, rows: 30 };

  constructor(
    readonly id: string,
    giveUpMs: number,
  ) {
    this.timer = setTimeout(() => this.lose(), giveUpMs).unref();
  }

  /** What the worker is told it's picking up: nothing on screen yet, at the size it starts with. */
  adopted(): Adopted {
    return { pty: this, ...this.size, busy: false, title: '', snapshot: '' };
  }

  write(data: string) {
    this.inner?.write(data);
  }

  resize(cols: number, rows: number) {
    this.size = { cols, rows };
    this.inner?.resize(cols, rows);
  }

  kill() {
    if (this.inner) this.inner.kill();
    else this.finish({ exitCode: -1 });
  }

  onData(cb: (data: string) => void) {
    this.dataCbs.push(cb);
  }

  onExit(cb: (e: PtyExit) => void) {
    this.exitCbs.push(cb);
    if (this.exited) cb(this.exited);
  }

  /** The node is back with it: its screen so far, then everything it prints, at the size the office has it. */
  bind(a: Adopted) {
    if (this.exited) return a.pty.kill();
    clearTimeout(this.timer);
    this.inner = a.pty;
    for (const cb of this.dataCbs) cb(a.snapshot);
    a.pty.onData((data) => {
      for (const cb of this.dataCbs) cb(data);
    });
    a.pty.onExit((e) => this.finish(e));
    if (a.cols !== this.size.cols || a.rows !== this.size.rows) a.pty.resize(this.size.cols, this.size.rows);
  }

  /** Its node came back without it, or not at all: the worker resumes its conversation. */
  lose() {
    this.finish({ exitCode: -1, lost: true });
  }

  private finish(e: PtyExit) {
    if (this.exited) return;
    clearTimeout(this.timer);
    this.exited = e;
    for (const cb of this.exitCbs) cb(e);
  }
}
