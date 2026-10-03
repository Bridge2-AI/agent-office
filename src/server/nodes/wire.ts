/** What the office and a node (`agent-office node`, a teammate's machine lending its compute) say to each other over the node's WebSocket. */
import type { NodeStats } from '../../shared/protocol/nodes.js';

export type { NodeStats };

/** Bump whenever these messages change: a node on another version is told to upgrade. */
export const NODE_PROTOCOL = 1;
export const NODE_PATH = '/node';
/** How long a node that dropped off keeps its workers' terminals, waiting to come back. */
export const GRACE_MS = 2 * 60_000;
/** Unacknowledged frames past this and the link gives up on the session instead of growing forever. */
export const MAX_UNACKED_BYTES = 16 * 1024 * 1024;

/** What a worker on a node needs that its spawn options don't say: its worktree, made there from origin. */
export interface RemoteSpawn {
  /** Relative to the project dir. */
  path: string;
  branch: string;
  base: string;
  from?: string;
  /** Keys of `env` the office set itself; the rest of the node's environment is its own. */
  envKeys: string[];
}

/** The first message each way; everything after it goes through a Link. */
export type Hello =
  | { t: 'hello'; version: number; name: string; token: string; session?: string; got?: number }
  | { t: 'welcome'; session: string; resumed: boolean; got: number }
  | { t: 'refused'; why: string };

/** Office → node, inside the link. `ch` is a floor (its data dir on the office). */
export type ToNode =
  | { t: 'floor.open'; ch: string; dir: string; origin: string }
  | { t: 'pty'; ch: string; m: any }
  | { t: 'http.res'; id: number; status: number; type?: string; body: string };

/** Node → office, inside the link. */
export type FromNode =
  | { t: 'floor.ready'; ch: string; version: number; sessions: string[] }
  | { t: 'floor.error'; ch: string; error: string }
  | { t: 'pty'; ch: string; m: any }
  | { t: 'stats'; stats: NodeStats }
  | { t: 'http'; id: number; method: string; path: string; auth?: string; type?: string; body: string };

/** One frame of a link: a numbered message, or how far the sender has got with the other side's. */
export type Frame<M> = { s: number; m: M } | { a: number };
