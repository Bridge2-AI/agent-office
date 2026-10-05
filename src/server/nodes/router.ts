import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import { PtyHost, type Adopted, type Pty, type SpawnOpts } from '../ptys.js';
import { childEnv } from '../workers/env.js';
import { HOST, hub, type Routed } from './hub.js';
import { PendingPty } from './pending.js';
import { GRACE_MS } from './wire.js';

/** Sign-ins that are the office's (or an account's on it): a node's workers use its own user's instead. */
const OFFICE_ONLY = new Set(['PATH', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
/** A worker hired longer ago than this was placed before nodes existed: it stays where it is. */
const PLACE_WINDOW_MS = 60_000;

/** What the router needs of its floor's workers. */
export interface RoutedWorkers {
  get(id: string): WorkerInfo | undefined;
  list(): WorkerInfo[];
  resume(id: string): string | undefined;
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
    const info = this.workers.get(opts.env.AGENT_OFFICE_WORKER_ID ?? '');
    const fresh = info?.node === undefined;
    const node = info && this.where(info);
    if (!info || !node) return super.spawn(opts);
    const host = hub.hostOn(node, this.ch);
    if (!host) throw new Error(`it runs on ${node}, which isn't connected to the office right now — it starts again when ${node} is back`);
    if (fresh && hub.atLimit(node)) throw new Error(`${node} is at its worker limit`);
    if (fresh) hub.placed(node);
    const p = host.spawn(remoteOpts(opts, info));
    this.remember(p, node);
    return p;
  }

  /**
   * A terminal from before the office restarted. One on a node can't be asked for yet (the office
   * isn't open to its nodes until its workers are back), so its worker gets a PendingPty, joined to
   * the real one once the node is back (nodeUp).
   */
  override async attach(id: string): Promise<Adopted | undefined> {
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
  return { ...opts, env, remote: { path: wt.path, branch: wt.branch, base: wt.base, from: wt.from, envKeys: Object.keys(env) } };
}
