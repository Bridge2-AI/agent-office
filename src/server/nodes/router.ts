import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import { PtyHost, type Adopted, type Pty, type SpawnOpts } from '../ptys.js';
import { childEnv } from '../workers/env.js';
import { HOST, hub, type Routed } from './hub.js';

/** Sign-ins that are the office's (or an account's on it): a node's workers use its own user's instead. */
const OFFICE_ONLY = new Set(['PATH', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
/** How long the office, starting up, waits for a node to come back with a worker's terminal. */
const ATTACH_WAIT_MS = 10_000;
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
  /** Past the office's start-up: a node coming back now has its workers resumed rather than attached. */
  private started = false;

  constructor(
    dataDir: string,
    onLost: () => void,
    private workers: RoutedWorkers,
  ) {
    super(dataDir, onLost);
    this.ch = dataDir;
    this.dir = path.dirname(dataDir);
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
    const node = info && this.where(info);
    if (!info || !node) return super.spawn(opts);
    const host = hub.hostOn(node, this.ch);
    if (!host) throw new Error(`it runs on ${node}, which isn't connected to the office right now — it starts again when ${node} is back`);
    hub.placed(node);
    return host.spawn(remoteOpts(opts, info));
  }

  override async attach(id: string): Promise<Adopted | undefined> {
    const local = await super.attach(id);
    if (local) return local;
    const deadline = Date.now() + ATTACH_WAIT_MS;
    for (;;) {
      const held = hub.holder(this.ch, id);
      if (held) return held.host.attach(id);
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  override killUnclaimed() {
    super.killUnclaimed();
    for (const host of hub.hosts(this.ch)) host.killUnclaimed();
    this.started = true;
  }

  override detach() {
    super.detach();
    hub.removeRouter(this);
  }

  override stop() {
    super.stop();
    for (const host of hub.hosts(this.ch)) host.stop();
    hub.removeRouter(this);
  }

  nodeUp(node: string, host: PtyHost) {
    if (!this.started) return; // the office's start-up attaches what's still running there
    host.killUnclaimed();
    for (const w of this.workers.list()) if (w.node === node && w.status === 'exited') this.workers.resume(w.id);
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
