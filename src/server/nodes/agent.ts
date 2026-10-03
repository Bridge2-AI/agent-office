import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { AGENT_PROVIDERS } from '../../shared/providers.js';
import { excludeFromGit } from '../config.js';
import { DSH_PROFILE_DEFAULT } from '../dsh.js';
import { PROVIDERS } from '../providers/index.js';
import { PTY_PROTOCOL, PtyHost, readMessages, type SpawnOpts } from '../ptys.js';
import { childEnv } from '../workers/env.js';
import { binScript, defaultShell, resolveCommand, shellRun, shq, writeOfficeCommands } from '../workers/process.js';
import { Carry, git, handOff, makeWorktree, takeOver, unpack, writePiece } from './handoff.js';
import { Link } from './link.js';
import { NODE_PATH, NODE_PROTOCOL, type FromNode, type Hello, type NodeCall, type ToNode } from './wire.js';

const HELP = `agent-office node — lend this machine's compute to an office

Usage:
  agent-office node --office <url> --token <token> [options]

Leave it running. The office runs some of its new workers here: each in a git
worktree of a clone of its project on this machine, as you, with your own
claude and gh sign-ins. Its terminal shows in the office like any other, and its
work comes back the way all work does: pushed, as a pull request.

The office machine makes the token: agent-office nodes add <name> prints this
whole command.

Options:
  --office <url>        The office, as a browser opens it (https://…:4600)
  --token <token>       This node's token (or $AGENT_OFFICE_NODE_TOKEN)
  --name <name>         The name it was added as (default: this machine's name)
  --pin <sha256>        The office's certificate fingerprint, for a self-signed one
  --projects <dir>      Where the office's projects are cloned on this machine
                        (default ~/agent-office-node)
  --max-workers <n>     Take at most n workers at once
  -h, --help            This help
`;

/** What `agent-office node` was started with. */
interface Options {
  office: URL;
  token: string;
  name: string;
  pin?: string;
  projects: string;
  maxWorkers?: number;
}

interface Floor {
  ch: string;
  officeDir: string;
  dir: string;
  bin?: string;
  sock?: net.Socket;
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);
const STATS_MS = 5000;

export async function nodeCommand(argv: string[]): Promise<number> {
  const opts = parse(argv);
  if (typeof opts === 'number') return opts;
  await new Node(opts).run();
  return 0;
}

function parse(argv: string[]): Options | number {
  let office = '';
  let token = process.env.AGENT_OFFICE_NODE_TOKEN ?? '';
  let name = os.hostname();
  let pin: string | undefined;
  let projects = path.join(os.homedir(), 'agent-office-node');
  let maxWorkers: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (!argv[i + 1]) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    try {
      if (a === '-h' || a === '--help') {
        process.stdout.write(HELP);
        return 0;
      } else if (a === '--office') office = value();
      else if (a === '--token') token = value();
      else if (a === '--name') name = value();
      else if (a === '--pin') pin = value();
      else if (a === '--projects') projects = path.resolve(value());
      else if (a === '--max-workers') maxWorkers = Math.max(1, Number(value()) || 1);
      else throw new Error(`unknown option ${a}`);
    } catch (err) {
      console.error(`agent-office node: ${(err as Error).message}\n\n${HELP}`);
      return 2;
    }
  }
  if (!office || !token) {
    console.error(`agent-office node: --office and --token are needed\n\n${HELP}`);
    return 2;
  }
  let url: URL;
  try {
    url = new URL(office);
  } catch {
    console.error(`agent-office node: ${office} isn't a URL`);
    return 2;
  }
  return { office: url, token, name, pin: pin && fingerprint(pin), projects, maxWorkers };
}

/** `sha256:AB:CD…`, `AB:CD…` or `abcd…`, as one form to compare. */
function fingerprint(s: string): string {
  return s.replace(/^sha256:/i, '').replace(/:/g, '').toLowerCase();
}

/** owner/repo of a clone URL (https://github.com/o/r.git, git@github.com:o/r.git). */
export function repoPath(origin: string): string {
  const parts = origin
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean);
  return path.join(...parts.slice(-2));
}

class Node {
  private link?: Link<FromNode, ToNode>;
  private session?: string;
  private floors = new Map<string, Floor>();
  /** Terminals running here for the office, for the stats. */
  private live = new Set<string>();
  private relayUrl = '';
  private pending = new Map<number, (r: Extract<ToNode, { t: 'http.res' }>) => void>();
  private nextId = 0;
  private commands = new Map<string, string | null>();
  private backoff = 1000;
  private carry = new Carry();

  constructor(private o: Options) {}

  async run() {
    mkdirSync(this.o.projects, { recursive: true });
    this.relayUrl = await this.startRelay();
    if (this.o.office.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(this.o.office.hostname)) console.warn("agent-office node: the office is plain http, so the workers' terminals cross the network unencrypted — start it with --self-signed and pass --pin, or use Tailscale");
    setInterval(() => this.sendStats(), STATS_MS);
    this.connect();
    await new Promise(() => {}); // runs until Ctrl+C
  }

  private connect() {
    const url = new URL(NODE_PATH, this.o.office);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { rejectUnauthorized: !this.o.pin, maxPayload: 64 * 1024 * 1024 });
    // With a pin, the token goes out only once the certificate is the office's.
    if (this.o.pin) {
      ws.on('upgrade', (res) => {
        const fp = (res.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256 ?? '';
        if (fingerprint(fp) === this.o.pin) return;
        console.error(`agent-office node: ${this.o.office.host} isn't the office pinned (its certificate is ${fp || 'missing'}) — not connecting`);
        ws.terminate();
      });
    }
    ws.on('open', () => {
      const resume = this.link && !this.link.closed;
      ws.send(JSON.stringify({ t: 'hello', version: NODE_PROTOCOL, name: this.o.name, token: this.o.token, session: resume ? this.session : undefined, got: resume ? this.link!.received : 0 } satisfies Hello));
    });
    ws.once('message', (raw) => {
      let h: Hello;
      try {
        h = JSON.parse(String(raw));
      } catch {
        return ws.terminate();
      }
      if (h.t === 'refused') {
        console.error(`agent-office node: the office refused this node: ${h.why}`);
        process.exit(1);
      }
      if (h.t !== 'welcome') return ws.terminate();
      if (!h.resumed || !this.link || this.link.closed) this.fresh(ws, h.session);
      this.link!.bind(ws, h.got);
      this.backoff = 1000;
      console.log(`agent-office node: ${h.resumed ? 'back in' : 'joined'} the office at ${this.o.office.origin} as ${this.o.name}`);
      this.sendStats();
    });
    ws.on('close', () => {
      this.link?.unbind(ws);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    });
    ws.on('error', (err) => {
      if (this.backoff <= 1000) console.error(`agent-office node: ${err.message} — trying again`);
    });
  }

  /** A new session with the office (it restarted, or gave up on us): it opens every floor again and picks up the terminals still running. */
  private fresh(ws: WebSocket, session: string) {
    this.link?.close();
    for (const f of this.floors.values()) f.sock?.end();
    this.floors.clear();
    this.live.clear();
    this.session = session;
    this.link = new Link<FromNode, ToNode>(
      (m) => this.onMessage(m),
      () => ws.terminate(),
    );
  }

  private send(m: FromNode) {
    this.link?.send(m);
  }

  private onMessage(m: ToNode) {
    switch (m.t) {
      case 'floor.open':
        void this.openFloor(m.ch, m.dir, m.origin).catch((err) => this.send({ t: 'floor.error', ch: m.ch, error: (err as Error).message }));
        break;
      case 'pty': {
        const f = this.floors.get(m.ch);
        if (m.m?.t === 'spawn') {
          if (f?.sock) void this.spawn(f, m.m.id, m.m.opts);
          else this.send({ t: 'pty', ch: m.ch, m: { t: 'exit', id: m.m.id, exitCode: -1, error: "this node hasn't got the project ready yet" } });
        } else f?.sock?.write(`${JSON.stringify(m.m)}\n`);
        break;
      }
      case 'http.res':
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
        break;
      case 'rpc':
        this.call(m).then(
          (result) => this.send({ t: 'rpc.res', id: m.id, ok: true, result }),
          (err) => this.send({ t: 'rpc.res', id: m.id, ok: false, error: (err as Error).message }),
        );
        break;
    }
  }

  /** What the office asks of this machine while it moves a worker to or from it (see handoff.ts). */
  private async call(c: NodeCall): Promise<unknown> {
    const where = (ch: string, rel: string) => {
      const f = this.floors.get(ch);
      if (!f) throw new Error("this node hasn't got the project ready");
      return { dir: f.dir, cwd: path.join(f.dir, rel) };
    };
    switch (c.op) {
      case 'handoff':
        return handOff(where(c.ch, c.path).cwd, c.message);
      case 'takeover': {
        const { dir, cwd } = where(c.ch, c.wt.path);
        return takeOver(dir, cwd, c.wt, c.branch);
      }
      case 'session.pack':
        return this.carry.pack(c.carrier, c.sessionId, where(c.ch, c.path).cwd, process.env);
      case 'session.read':
        return this.carry.read(c.sessionId, c.key, c.offset);
      case 'session.done':
        return this.carry.done(c.sessionId);
      case 'session.write':
        return writePiece(c.carrier, c.sessionId, c.key, where(c.ch, c.path).cwd, process.env, c.offset, c.data);
      case 'session.unpack':
        return unpack(c.carrier, c.sessionId, c.keys, c.fromCwd, where(c.ch, c.path).cwd, process.env);
    }
  }

  /** The office's project here: cloned the first time, with what its workers need, and its own terminal host. */
  private async openFloor(ch: string, officeDir: string, origin: string) {
    const dir = path.join(this.o.projects, repoPath(origin));
    if (!existsSync(path.join(dir, '.git'))) {
      console.log(`agent-office node: cloning ${origin} into ${dir}`);
      mkdirSync(path.dirname(dir), { recursive: true });
      await git(['clone', '--quiet', origin, dir], this.o.projects, 10 * 60_000);
    }
    excludeFromGit(dir);
    const data = path.join(dir, '.agent-office');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    for (const p of AGENT_PROVIDERS) PROVIDERS[p].prepare?.({ dataDir: data, mcpScript: binScript('office-workers.js'), dshProfile: DSH_PROFILE_DEFAULT });
    const floor: Floor = { ch, officeDir, dir, bin: writeOfficeCommands(data) };
    const found = await new PtyHost(data, () => {}).open();
    if (!found) throw new Error("couldn't start a terminal host here");
    floor.sock = found.sock;
    this.floors.set(ch, floor);
    readMessages(found.sock, (msg) => this.fromHost(floor, msg));
    found.sock.on('close', () => {
      if (this.floors.get(ch) !== floor) return;
      this.floors.delete(ch);
      this.send({ t: 'floor.error', ch, error: 'its terminal host stopped' });
    });
    for (const id of found.sessions) this.live.add(id);
    this.send({ t: 'floor.ready', ch, version: PTY_PROTOCOL, sessions: found.sessions });
  }

  private fromHost(f: Floor, m: any) {
    if (m.t === 'spawned' || m.t === 'attached') {
      this.live.add(m.id);
      // The office's port scan reads its own machine's processes: a pid from here would name one of those.
      m.pid = 0;
    } else if (m.t === 'exit' || m.t === 'gone') this.live.delete(m.id);
    this.send({ t: 'pty', ch: f.ch, m });
  }

  /** The office's spawn, made to work here: this machine's paths, commands, environment and the worker's worktree. */
  private async spawn(f: Floor, id: string, opts: SpawnOpts) {
    try {
      const r = opts.remote;
      if (!r) throw new Error('the office sent a spawn with no worktree');
      // The office's paths, in what it says to run, made this machine's: its project, and its install.
      const swaps: [string, string][] = [[f.officeDir, f.dir], [r.officeNode, process.execPath]];
      const bin = binScript('office-workers.js');
      if (r.officeBin && bin) swaps.push([r.officeBin, path.dirname(bin)]);
      const map = (s: string) => swaps.reduce((acc, [a, b]) => acc.split(a).join(b), s);
      const cwd = map(opts.cwd);
      await makeWorktree(f.dir, cwd, r);
      const env = childEnv();
      for (const k of r.envKeys) if (opts.env[k] !== undefined) env[k] = map(opts.env[k]);
      Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', AGENT_OFFICE_HOOK_URL: this.relayUrl });
      if (f.bin) env.PATH = [f.bin, env.PATH].filter(Boolean).join(path.delimiter);
      const args = opts.args.map(map);
      const name = path.basename(opts.file);
      let file = defaultShell();
      let argv = args;
      if (!SHELLS.has(name)) {
        const found = this.command(name);
        if (found) file = found;
        else argv = shellRun(['exec', name, ...args].map((a, i) => (i < 2 ? a : shq(a))).join(' '));
      }
      const spawn: SpawnOpts = { file, args: argv, cwd, env, cols: opts.cols, rows: opts.rows, prelude: opts.prelude };
      f.sock!.write(`${JSON.stringify({ t: 'spawn', id, opts: spawn })}\n`);
    } catch (err) {
      this.send({ t: 'pty', ch: f.ch, m: { t: 'exit', id, exitCode: -1, error: (err as Error).message } });
    }
  }

  private command(name: string): string | null {
    if (!this.commands.has(name)) this.commands.set(name, resolveCommand(name));
    return this.commands.get(name)!;
  }

  /** Where this machine's workers send their hooks and office-workers calls: on to the office, over the link. */
  private startRelay(): Promise<string> {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        const id = ++this.nextId;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          res.writeHead(504).end('the office is unreachable');
        }, 60_000);
        this.pending.set(id, (r) => {
          clearTimeout(timer);
          res.writeHead(r.status, r.type ? { 'content-type': r.type } : {}).end(r.body);
        });
        const auth = req.headers.authorization;
        const type = req.headers['content-type'];
        this.send({ t: 'http', id, method: req.method ?? 'GET', path: req.url ?? '/', auth, type, body });
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)));
  }

  private sendStats() {
    if (!this.link?.connected) return;
    const cores = os.cpus().length;
    this.send({ t: 'stats', stats: { cores, load: os.loadavg()[0], memTotal: os.totalmem(), memFree: os.freemem(), workers: this.live.size, maxWorkers: this.o.maxWorkers } });
  }
}
