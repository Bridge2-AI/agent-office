import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import { PtyHost, type Adopted, type Pty, type SpawnOpts } from '../ptys.js';
import { childEnv } from '../workers/env.js';
import { binScript } from '../workers/process.js';
import { CARRIERS, Carry, claudeConfigDir, handOff, takeOver, unpack, writePiece, type Carrier, type Pack } from './handoff.js';
import { HOST, hub, type Routed } from './hub.js';
import { PendingPty } from './pending.js';
import { GRACE_MS } from './wire.js';

/** Sign-ins that are the office's (or an account's on it): a node's workers use its own user's instead. */
const OFFICE_ONLY = new Set(['PATH', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
/** A worker hired longer ago than this was placed before nodes existed: it stays where it is. */
const PLACE_WINDOW_MS = 60_000;
/** The office's own end of carrying conversations (see handoff.ts). */
const carry = new Carry();

/** What the router needs of its floor's workers. */
export interface RoutedWorkers {
  get(id: string): WorkerInfo | undefined;
  list(): WorkerInfo[];
  resume(id: string): string | undefined;
  ownerOf(id: string): string | undefined;
}

/**
 * A floor's terminal host that also runs workers on nodes (see hub.ts). It is the local host
 * (PtyHost) for everything that stays on the office's machine; a new agent in its own worktree may
 * go to a node instead, picked when it's hired, and stays on that node from then on.
 */
export class NodeRouter extends PtyHost implements Routed {
  readonly ch: string;
  readonly dir: string;
  private remote?: string | null;
  /** Past the office's start-up: what a node coming back has that nobody claimed is ended. */
  private started = false;
  /** Which node each terminal there runs on, kept on disk for the next office (see attach). */
  private onNode: Record<string, string>;
  private pending = new Map<string, PendingPty>();
  private onNodeFile: string;
  /** Each running worker's terminal, wherever it is, so a move can stop it. */
  private byWorker = new Map<string, Pty>();
  /** Whose terminal each one from before a restart is (workers.json), for byWorker. */
  private ptyWorker = new Map<string, string>();
  private moving = new Set<string>();

  constructor(
    dataDir: string,
    onLost: () => void,
    private workers: RoutedWorkers,
  ) {
    super(dataDir, onLost);
    this.ch = dataDir;
    this.dir = path.dirname(dataDir);
    this.onNodeFile = path.join(dataDir, 'node-ptys.json');
    try {
      this.onNode = JSON.parse(readFileSync(this.onNodeFile, 'utf8'));
    } catch {
      this.onNode = {};
    }
    try {
      for (const w of JSON.parse(readFileSync(path.join(dataDir, 'workers.json'), 'utf8'))) if (w?.pty?.id) this.ptyWorker.set(w.pty.id, w.id);
    } catch {
      // no workers yet
    }
    hub.addRouter(this);
  }

  origin(): string | undefined {
    if (this.remote === undefined) {
      try {
        this.remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: this.dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      } catch {
        this.remote = null;
      }
    }
    return this.remote ?? undefined;
  }

  override spawn(opts: SpawnOpts): Pty {
    const id = opts.env.AGENT_OFFICE_WORKER_ID ?? '';
    if (this.moving.has(id)) throw new Error("it's moving to another machine, and starts again there in a moment");
    const info = this.workers.get(id);
    const node = info && this.where(info);
    let p: Pty;
    if (!info || !node) p = super.spawn(opts);
    else {
      const host = hub.hostOn(node, this.ch);
      if (!host) throw new Error(hub.online(node) ? `it runs on ${node}, which is still getting this project ready — it starts there once it is` : `it runs on ${node}, which isn't connected to the office right now — it starts again when ${node} is back`);
      hub.placed(node);
      p = host.spawn(remoteOpts(opts, info));
      this.remember(p, node);
    }
    if (id) this.track(id, p);
    return p;
  }

  /**
   * A terminal from before the office restarted. One on a node can't be asked for yet (the office
   * isn't open to its nodes until its workers are back), so its worker gets a PendingPty, joined to
   * the real one once the node is back (nodeUp).
   */
  override async attach(id: string): Promise<Adopted | undefined> {
    const adopted = await this.find(id);
    const worker = this.ptyWorker.get(id);
    if (adopted && worker) this.track(worker, adopted.pty);
    return adopted;
  }

  private async find(id: string): Promise<Adopted | undefined> {
    const local = await super.attach(id);
    const node = this.onNode[id];
    if (local || !node) return local;
    const held = hub.holder(this.ch, id);
    if (held) return held.host.attach(id);
    const p = new PendingPty(id, GRACE_MS);
    this.pending.set(id, p);
    p.onExit(() => this.pending.delete(id));
    this.remember(p, node);
    return p.adopted();
  }

  /**
   * Moves a worker to another machine (`to`, a node, or '' for the office's own), conversation and
   * all: it stops, its work is committed and pushed where it was, its worktree there is brought to
   * that commit, its Claude conversation is copied across, and it starts again there, carrying on.
   * Anything going wrong leaves it where it was, started again. Says what went wrong.
   */
  async move(id: string, to: string): Promise<string | undefined> {
    const why = this.cantMove(id, to);
    if (why) return why;
    const info = this.workers.get(id)!;
    const from = info.node ?? '';
    const wt = info.worktree!;
    this.moving.add(id);
    try {
      if (!(await this.halt(id))) throw new Error("it didn't stop in time");
      const message = `wip: ${info.name} moves to ${to || 'the office'}`;
      const { branch } = from ? await hub.call(from, { op: 'handoff', ch: this.ch, path: wt.path, message }) : await handOff(path.join(this.dir, wt.path), message);
      const at = { path: wt.path, branch: wt.branch, base: wt.base, from: wt.from };
      if (to) await hub.call(to, { op: 'takeover', ch: this.ch, wt: at, branch });
      else await takeOver(this.dir, path.join(this.dir, wt.path), at, branch);
      const carrier = CARRIERS[info.provider ?? ''];
      if (info.sessionId && carrier) await this.carrySession(id, carrier, info.sessionId, from, to, wt.path);
      if (branch !== wt.branch) info.worktree = { ...wt, branch, made: wt.made ?? wt.branch };
      info.node = to;
      return undefined;
    } catch (err) {
      return `Couldn't move ${info.name}, so it carries on where it was: ${(err as Error).message}`;
    } finally {
      this.moving.delete(id);
      this.workers.resume(id);
    }
  }

  /** Why a worker can't move to `to` now, if it can't. */
  cantMove(id: string, to: string): string | undefined {
    const info = this.workers.get(id);
    if (!info) return 'No such worker';
    if (!portable(info)) return 'Only an agent in its own worktree can move to another machine';
    const from = info.node ?? '';
    if (from === to) return `${info.name} already runs ${to ? `on ${to}` : "on the office's machine"}`;
    if (this.moving.has(id)) return `${info.name} is already moving`;
    if (info.status === 'working') return `${info.name} is in the middle of something: move it once it's done (Esc in its terminal stops it)`;
    for (const n of [from, to]) if (n && !hub.hostOn(n, this.ch)) return `${n} isn't connected to the office`;
    return undefined;
  }

  private track(worker: string, p: Pty) {
    this.byWorker.set(worker, p);
    p.onExit(() => {
      if (this.byWorker.get(worker) === p) this.byWorker.delete(worker);
    });
  }

  /** Ends a worker's terminal and waits for it: false if it's still going after a while, and mustn't be moved from under. */
  private halt(worker: string): Promise<boolean> {
    const p = this.byWorker.get(worker);
    if (!p) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      p.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
      p.kill();
    });
  }

  /** A worker's conversation, carried a piece at a time from where it was to where its agent looks for it on `to`. */
  private async carrySession(worker: string, carrier: Carrier, sessionId: string, from: string, to: string, rel: string) {
    const env = this.envOf(worker);
    const ch = this.ch;
    const pack: Pack = from ? await hub.call(from, { op: 'session.pack', carrier, ch, path: rel, sessionId }) : await carry.pack(carrier, sessionId, path.join(this.dir, rel), env);
    try {
      for (const { key } of pack.files) {
        for (let offset = 0; ; ) {
          const piece: { data: string; size: number } = from ? await hub.call(from, { op: 'session.read', sessionId, key, offset }) : carry.read(sessionId, key, offset);
          if (to) await hub.call(to, { op: 'session.write', carrier, ch, path: rel, sessionId, key, offset, data: piece.data });
          else writePiece(carrier, sessionId, key, path.join(this.dir, rel), env, offset, piece.data);
          const n = Buffer.from(piece.data, 'base64').length;
          offset += n;
          if (!n || offset >= piece.size) break;
        }
      }
      const keys = pack.files.map((f) => f.key);
      if (!keys.length) return; // nothing to take along: it starts a fresh conversation there
      if (to) await hub.call(to, { op: 'session.unpack', carrier, ch, path: rel, sessionId, keys, fromCwd: pack.cwd });
      else await unpack(carrier, sessionId, keys, pack.cwd, path.join(this.dir, rel), env);
    } finally {
      if (from) await hub.call(from, { op: 'session.done', sessionId }).catch(() => {});
      else carry.done(sessionId);
    }
  }

  /** The environment a worker's agent has on the office's machine: an account's own Claude keeps its conversations in its own folder (see signins.ts). */
  private envOf(worker: string): NodeJS.ProcessEnv {
    const owner = this.workers.ownerOf(worker);
    const own = owner && hub.officeData ? path.join(hub.officeData, 'homes', owner, 'claude') : undefined;
    return own && existsSync(own) ? { ...process.env, CLAUDE_CONFIG_DIR: own } : process.env;
  }

  override killUnclaimed() {
    super.killUnclaimed();
    for (const host of hub.hosts(this.ch)) host.killUnclaimed();
    this.started = true;
  }

  override detach() {
    super.detach();
    for (const host of hub.hosts(this.ch)) host.detach();
    hub.removeRouter(this);
  }

  override stop() {
    super.stop();
    for (const host of hub.hosts(this.ch)) host.stop();
    hub.removeRouter(this);
  }

  /** A node's terminal host for this floor is up, with `sessions` still running there. */
  nodeUp(node: string, host: PtyHost, sessions: string[]) {
    for (const [id, p] of this.pending) {
      if (this.onNode[id] !== node) continue;
      if (sessions.includes(id)) void host.attach(id).then((a) => (a ? p.bind(a) : p.lose()));
      else p.lose();
    }
    if (!this.started) return; // the office's start-up attaches what's still running there
    host.killUnclaimed();
    for (const w of this.workers.list()) if (w.node === node && w.status === 'exited') this.workers.resume(w.id);
  }

  private remember(p: Pty, node: string) {
    if (!p.id) return;
    this.onNode[p.id] = node;
    this.saveOnNode();
    p.onExit(() => {
      delete this.onNode[p.id!];
      this.saveOnNode();
    });
  }

  private saveOnNode() {
    try {
      writeFileSync(this.onNodeFile, JSON.stringify(this.onNode), { mode: 0o600 });
    } catch {
      // the next office resumes these workers instead of picking them up
    }
  }

  /** Which node a worker runs on, deciding it the first time it starts; undefined is the office's own machine. */
  private where(info: WorkerInfo): string | undefined {
    if (info.node === undefined) {
      const pin = hub.takePin(this.ch, info.deskId);
      const fresh = Date.now() - info.createdAt < PLACE_WINDOW_MS;
      const node = fresh && portable(info) ? (pin ?? hub.place(this.ch)) : HOST;
      info.node = node === HOST ? '' : node;
    }
    return info.node || undefined;
  }
}

/** Only an agent in a worktree of its own can work elsewhere: its branch is how its work comes back. */
function portable(info: WorkerInfo): boolean {
  return info.kind === 'agent' && !!info.worktree && !info.repos?.length && !info.meeting && !DESK_BY_ID.get(info.deskId)?.station;
}

/** Just what the office set of the environment travels, never its own PATH or sign-ins; the node maps the paths. */
function remoteOpts(opts: SpawnOpts, info: WorkerInfo): SpawnOpts {
  const base = childEnv();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (base[k] !== v && !OFFICE_ONLY.has(k)) env[k] = v;
  const wt = info.worktree!;
  const bin = binScript('office-workers.js');
  return { ...opts, env, remote: { path: wt.path, branch: wt.branch, base: wt.base, from: wt.from, envKeys: Object.keys(env), officeNode: process.execPath, officeBin: bin && path.dirname(bin) } };
}
