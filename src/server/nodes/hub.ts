import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { NodeView } from '../../shared/protocol.js';
import { PtyHost } from '../ptys.js';
import { Link } from './link.js';
import { GRACE_MS, NODE_PROTOCOL, type FromNode, type Hello, type NodeStats, type ToNode } from './wire.js';

/** What a floor's router gives the hub (see NodeRouter). */
export interface Routed {
  /** The floor's data dir: the channel its terminals go over on every node. */
  readonly ch: string;
  readonly dir: string;
  origin(): string | undefined;
  /** A node's terminal host for this floor came up, with `sessions` still running there. */
  nodeUp(node: string, host: PtyHost, sessions: string[]): void;
}

interface Channel {
  host?: PtyHost;
  duplex?: Duplex;
  sessions: string[];
  error?: string;
}

interface Session {
  name: string;
  id: string;
  link: Link<ToNode, FromNode>;
  ws?: WebSocket;
  stats?: NodeStats;
  grace?: NodeJS.Timeout;
  channels: Map<string, Channel>;
  /** When workers were last placed here, so a burst of hires spreads before the stats catch up. */
  placed: number[];
}

interface Registered {
  name: string;
  hash: string;
  addedAt: number;
}

/** A hire that hasn't picked: Auto. `host` is the office's own machine. */
export const HOST = 'host';
/** What one more worker is guessed to take before the node's stats show it. */
const WORKER_MB = 700;
/** The office's own machine keeps this much back for the office and the browsers' terminals. */
const HOST_RESERVE_MB = 1536;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The office's side of its nodes: who may connect (nodes.json), their links, each floor's terminal
 * host on each of them, and where a new worker goes (place). One per office.
 */
class Hub {
  private file?: string;
  private hookUrl = '';
  private notify: (text: string) => void = () => {};
  private changed: () => void = () => {};
  private sessions = new Map<string, Session>();
  private routers = new Map<string, Routed>();
  private pins = new Map<string, string>();
  /** Its own, for a terminal's snapshot can be far bigger than anything a browser sends. */
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  /** Called once the office knows where it keeps its data and where its hook server is. */
  init(dataDir: string, hookPort: number, notify: (text: string) => void, changed: () => void) {
    this.file = path.join(dataDir, 'nodes.json');
    this.hookUrl = `http://127.0.0.1:${hookPort}`;
    this.notify = notify;
    this.changed = changed;
  }

  /** The office is closing: links go, and a node that comes back finds a new office and a new session. */
  shutdown() {
    for (const s of [...this.sessions.values()]) this.end(s, false);
    this.routers.clear();
  }

  list(): NodeView[] {
    return registered(this.file).map(({ name }) => {
      const s = this.sessions.get(name);
      return { name, online: !!s?.link.connected, stats: s?.stats };
    });
  }

  // --- floors -----------------------------------------------------------------------------------

  addRouter(r: Routed) {
    this.routers.set(r.ch, r);
    for (const s of this.sessions.values()) this.openChannel(s, r);
  }

  removeRouter(r: Routed) {
    if (this.routers.get(r.ch) !== r) return;
    this.routers.delete(r.ch);
    for (const s of this.sessions.values()) s.channels.delete(r.ch);
  }

  /** The hire at `deskId` on floor `ch` goes to `node` (a node's name, HOST, or undefined for Auto). */
  pin(ch: string, deskId: string, node: string | undefined) {
    if (node) this.pins.set(`${ch}\n${deskId}`, node);
    else this.pins.delete(`${ch}\n${deskId}`);
  }

  takePin(ch: string, deskId: string): string | undefined {
    const key = `${ch}\n${deskId}`;
    const pin = this.pins.get(key);
    this.pins.delete(key);
    return pin;
  }

  /** The terminal host on `node` for floor `ch`, if it's there to take a worker now. */
  hostOn(node: string, ch: string): PtyHost | undefined {
    const s = this.sessions.get(node);
    return s?.link.connected ? s.channels.get(ch)?.host : undefined;
  }

  /** Every node's terminal host for floor `ch` that has the terminal `id` running from before. */
  holder(ch: string, id: string): { node: string; host: PtyHost } | undefined {
    for (const s of this.sessions.values()) {
      const c = s.channels.get(ch);
      if (c?.host && c.sessions.includes(id)) return { node: s.name, host: c.host };
    }
    return undefined;
  }

  hosts(ch: string): PtyHost[] {
    return [...this.sessions.values()].flatMap((s) => s.channels.get(ch)?.host ?? []);
  }

  /**
   * Where a new worker on floor `ch` goes: the machine with the most memory to spare (the office's
   * own counted too), skipping nodes that are full or haven't got the floor's project ready.
   */
  place(ch: string): string {
    // ponytail: free memory only, with a guess per fresh worker; weigh CPU load too if builds pile up on one node
    const recent = (s: Session) => (s.placed = s.placed.filter((t) => Date.now() - t < 60_000)).length;
    let best = HOST;
    let bestMb = os.freemem() / 2 ** 20 - HOST_RESERVE_MB;
    for (const s of this.sessions.values()) {
      if (!this.hostOn(s.name, ch) || !s.stats) continue;
      if (s.stats.maxWorkers && s.stats.workers + recent(s) >= s.stats.maxWorkers) continue;
      const mb = s.stats.memFree / 2 ** 20 - recent(s) * WORKER_MB;
      if (mb > bestMb) [best, bestMb] = [s.name, mb];
    }
    return best;
  }

  placed(node: string) {
    this.sessions.get(node)?.placed.push(Date.now());
  }

  // --- connections --------------------------------------------------------------------------------

  /** A node opening its WebSocket (NODE_PATH): it proves who it is in its first message, inside it. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  /** A node's WebSocket, before it has said who it is. */
  accept(ws: WebSocket) {
    // Anyone can get this far: nothing they send may throw out of here.
    ws.on('error', () => ws.terminate());
    const timer = setTimeout(() => ws.terminate(), 10_000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      let hello: Hello;
      try {
        hello = JSON.parse(String(raw));
      } catch {
        return ws.terminate();
      }
      const why = hello && typeof hello === 'object' ? this.check(hello) : 'Say hello first';
      if (why || hello.t !== 'hello') {
        ws.send(JSON.stringify({ t: 'refused', why: why ?? 'Say hello first' } satisfies Hello));
        return ws.close();
      }
      this.join(ws, hello);
    });
  }

  private check(h: Hello): string | undefined {
    if (h.t !== 'hello') return 'Say hello first';
    if (h.version !== NODE_PROTOCOL) return `This office speaks node protocol ${NODE_PROTOCOL} and the node ${h.version}: install the same agent-office version on both`;
    const reg = registered(this.file).find((n) => n.name === h.name);
    const a = Buffer.from(hash(String(h.token ?? '')));
    if (!reg || !timingSafeEqual(a, Buffer.from(reg.hash))) return 'Unknown node or wrong token (agent-office nodes add <name> on the office makes one)';
    return undefined;
  }

  private join(ws: WebSocket, h: Extract<Hello, { t: 'hello' }>) {
    let s = this.sessions.get(h.name);
    const resumed = !!s && !!h.session && s.id === h.session && !s.link.closed;
    if (s && !resumed) this.end(s, false);
    if (!s || !resumed) {
      const fresh: Session = { name: h.name, id: randomBytes(12).toString('hex'), channels: new Map(), placed: [], link: null! };
      fresh.link = new Link<ToNode, FromNode>(
        (m) => this.onMessage(fresh, m),
        () => this.end(fresh, true),
      );
      s = fresh;
      this.sessions.set(h.name, s);
    }
    const session = s;
    clearTimeout(session.grace);
    session.ws?.terminate();
    session.ws = ws;
    ws.send(JSON.stringify({ t: 'welcome', session: session.id, resumed, got: session.link.received } satisfies Hello));
    session.link.bind(ws, resumed ? (h.got ?? 0) : 0);
    ws.on('close', () => {
      session.link.unbind(ws);
      if (session.ws !== ws || session.link.closed) return;
      session.ws = undefined;
      this.changed();
      // Its terminals keep running there; they're given up on only if it stays away.
      session.grace = setTimeout(() => this.end(session, true), GRACE_MS).unref();
    });
    if (!resumed) {
      this.notify(`🖥️ ${h.name} joined the office: workers can run there now`);
      for (const r of this.routers.values()) this.openChannel(session, r);
    }
    this.changed();
  }

  /** The node's session is over: its terminals are lost to the office, and its workers resume when it's back. */
  private end(s: Session, announce: boolean) {
    if (this.sessions.get(s.name) === s) this.sessions.delete(s.name);
    clearTimeout(s.grace);
    s.link.close();
    // close, not terminate: what was just sent (a stop, as the office closes) still goes out first.
    s.ws?.close();
    s.ws = undefined;
    for (const c of s.channels.values()) c.duplex?.destroy();
    s.channels.clear();
    if (announce) this.notify(`🖥️ ${s.name} left the office: its workers pick up again when it's back`);
    this.changed();
  }

  private openChannel(s: Session, r: Routed) {
    const origin = r.origin();
    if (!origin) return; // a project with no origin can't be cloned anywhere else
    s.channels.set(r.ch, { sessions: [] });
    s.link.send({ t: 'floor.open', ch: r.ch, dir: r.dir, origin });
  }

  private onMessage(s: Session, m: FromNode) {
    switch (m.t) {
      case 'floor.ready': {
        const r = this.routers.get(m.ch);
        const c = s.channels.get(m.ch);
        if (!r || !c) return;
        const duplex = new Duplex({
          read() {},
          write(chunk, _enc, cb) {
            for (const line of String(chunk).split('\n')) if (line) s.link.send({ t: 'pty', ch: m.ch, m: JSON.parse(line) });
            cb();
          },
        });
        const host = new PtyHost(m.ch, () => this.notify(`🖥️ ${s.name}'s terminals stopped: its workers are resuming`));
        host.use(duplex, m.sessions);
        Object.assign(c, { host, duplex, sessions: m.sessions, error: undefined });
        r.nodeUp(s.name, host, m.sessions);
        this.changed();
        break;
      }
      case 'floor.error': {
        const c = s.channels.get(m.ch);
        if (!c) return;
        c.duplex?.destroy();
        Object.assign(c, { host: undefined, duplex: undefined, error: m.error });
        this.notify(`🖥️ ${s.name} can't take workers on ${path.basename(path.dirname(m.ch))}: ${m.error}`);
        const r = this.routers.get(m.ch);
        // Its terminal host may only have died: it's asked again in a while.
        if (r) setTimeout(() => s.channels.get(m.ch) === c && !s.link.closed && this.openChannel(s, r), 30_000);
        break;
      }
      case 'pty':
        s.channels.get(m.ch)?.duplex?.push(`${JSON.stringify(m.m)}\n`);
        break;
      case 'stats':
        s.stats = m.stats;
        this.changed();
        break;
      case 'http':
        void this.relay(s, m);
        break;
    }
  }

  /** A worker's hook or office-workers call on a node, made to the office's loopback hook server. */
  private async relay(s: Session, m: Extract<FromNode, { t: 'http' }>) {
    const reply = (status: number, body: string, type?: string) => s.link.send({ t: 'http.res', id: m.id, status, body, type });
    if (!/^\/(hooks|office)\//.test(m.path)) return reply(404, 'not found');
    try {
      const headers: Record<string, string> = {};
      if (m.auth) headers.authorization = m.auth;
      if (m.type) headers['content-type'] = m.type;
      const res = await fetch(this.hookUrl + m.path, { method: m.method, headers, body: m.method === 'GET' || m.method === 'HEAD' ? undefined : m.body, signal: AbortSignal.timeout(60_000) });
      reply(res.status, await res.text(), res.headers.get('content-type') ?? undefined);
    } catch (err) {
      reply(502, (err as Error).message);
    }
  }
}

export const hub = new Hub();

// --- nodes.json ------------------------------------------------------------------------------------

function registered(file: string | undefined): Registered[] {
  if (!file) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')).nodes;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Adds (or re-keys) a node; returns its token, which is only ever shown this once. */
export function registerNode(dataDir: string, name: string): string {
  const file = path.join(dataDir, 'nodes.json');
  const token = randomBytes(24).toString('hex');
  const nodes = registered(file).filter((n) => n.name !== name);
  nodes.push({ name, hash: hash(token), addedAt: Date.now() });
  writeFileSync(file, JSON.stringify({ nodes }, null, 2), { mode: 0o600 });
  return token;
}

export function unregisterNode(dataDir: string, name: string): boolean {
  const file = path.join(dataDir, 'nodes.json');
  const before = registered(file);
  const nodes = before.filter((n) => n.name !== name);
  writeFileSync(file, JSON.stringify({ nodes }, null, 2), { mode: 0o600 });
  return nodes.length !== before.length;
}

export function registeredNodes(dataDir: string): Registered[] {
  return registered(path.join(dataDir, 'nodes.json'));
}
