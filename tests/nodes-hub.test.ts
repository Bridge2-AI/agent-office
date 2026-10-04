// Nodes (docs/nodes.md) with one connected: the office's hub on a real WebSocket server on loopback,
// and fake nodes that speak to it as agent.ts does (a hello, then a Link). Covers the handshake,
// where a new worker goes (hub.place), and a floor's router sending a worker to a node.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST, hub, registerNode, type Routed } from '../src/server/nodes/hub.js';
import { Link } from '../src/server/nodes/link.js';
import { NodeRouter } from '../src/server/nodes/router.js';
import { GRACE_MS, NODE_PROTOCOL, type FromNode, type Hello, type NodeStats, type ToNode } from '../src/server/nodes/wire.js';
import { PTY_PROTOCOL, type SpawnOpts } from '../src/server/ptys.js';
import { childEnv } from '../src/server/workers/env.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-hub-'));
const notes: string[] = [];
hub.init(dir, 9, (text) => notes.push(text), () => {});

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws) => hub.accept(ws));
await once(wss, 'listening');
const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
const links: Link<FromNode, ToNode>[] = [];

after(async () => {
  hub.shutdown();
  for (const link of links) link.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Resolves to what `cond` gives once it's truthy; setImmediate, so mocked timers don't stall it. */
async function until<T>(cond: () => T, what = 'it'): Promise<NonNullable<T>> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

interface Joined {
  ws: WebSocket;
  /** The office's end of it. */
  server: WebSocket;
  reply: Hello;
}

/** Opens a connection and says `hello`. A welcomed node's link goes on it at once: the office's frames may be right behind. */
function connect(hello: object, link?: Link<FromNode, ToNode>): Promise<Joined> {
  const server = once(wss, 'connection');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.once('message', async (raw) => {
      const reply = JSON.parse(String(raw)) as Hello;
      if (link && reply.t === 'welcome') link.bind(ws, reply.got);
      resolve({ ws, reply, server: (await server)[0] as WebSocket });
    });
  });
}

/** A node as agent.ts is one: a link, and everything the office tells it over that link. */
function node(name: string, token: string) {
  const told: ToNode[] = [];
  const link = new Link<FromNode, ToNode>((m) => told.push(m), () => assert.fail(`${name}'s link overflowed`));
  links.push(link);
  return { told, link, join: (extra: object = {}) => connect({ t: 'hello', version: NODE_PROTOCOL, name, token, ...extra }, link) };
}

const view = (name: string) => hub.list().find((n) => n.name === name);
const GiB = 2 ** 30;
const stats = (s: Partial<NodeStats> = {}): NodeStats => ({ cores: 8, load: 0, memTotal: 64 * GiB, memFree: 8 * GiB, workers: 0, ...s });
/** A floor's router as the hub sees one. */
function floor(name: string, nodeUp: (node: string) => void = () => {}): Routed {
  const ch = path.join(dir, name, '.agent-office');
  return { ch, dir: path.dirname(ch), origin: () => `https://example.invalid/${name}.git`, nodeUp };
}

test('the office turns away an unknown node, a wrong token, another protocol version and anything but hello', async () => {
  const token = registerNode(dir, 'known');
  const why = async (hello: object) => {
    const { ws, reply } = await connect(hello);
    assert.equal(reply.t, 'refused');
    await until(() => ws.readyState === WebSocket.CLOSED, 'the office to hang up');
    return (reply as Extract<Hello, { t: 'refused' }>).why;
  };
  assert.match(await why({ t: 'hello', version: NODE_PROTOCOL, name: 'stranger', token }), /Unknown node or wrong token/);
  assert.match(await why({ t: 'hello', version: NODE_PROTOCOL, name: 'known', token: `${token}0` }), /Unknown node or wrong token/);
  assert.match(await why({ t: 'hello', version: NODE_PROTOCOL, name: 'known' }), /Unknown node or wrong token/);
  assert.match(await why({ t: 'hello', version: NODE_PROTOCOL + 1, name: 'known', token }), new RegExp(`protocol ${NODE_PROTOCOL} and the node ${NODE_PROTOCOL + 1}`));
  assert.match(await why({ t: 'welcome', session: 'x', resumed: false, got: 0 }), /Say hello first/);
  assert.deepEqual(view('known'), { name: 'known', online: false, stats: undefined });
});

test('a registered node is welcomed, and after its socket drops it resumes the same session', async () => {
  const token = registerNode(dir, 'laptop');
  const n = node('laptop', token);
  const first = await n.join();
  assert.equal(first.reply.t, 'welcome');
  const { session, resumed, got } = first.reply as Extract<Hello, { t: 'welcome' }>;
  assert.match(session, /^[0-9a-f]{24}$/);
  assert.deepEqual([resumed, got], [false, 0]);
  assert.equal(view('laptop')?.online, true);
  n.link.send({ t: 'stats', stats: stats() });
  await until(() => view('laptop')?.stats, 'its stats');

  // Its Wi-Fi blinks. What the office says meanwhile (a floor opening) waits for it.
  first.ws.terminate();
  await until(() => !view('laptop')?.online, 'the office to see it go');
  n.link.unbind(first.ws);
  const f = floor('resumed');
  hub.addRouter(f);
  try {
    const again = await n.join({ session, got: n.link.received });
    assert.deepEqual(again.reply, { t: 'welcome', session, resumed: true, got: 1 });
    const open = await until(() => n.told.find((m) => m.t === 'floor.open'), 'the floor it missed');
    assert.deepEqual(open, { t: 'floor.open', ch: f.ch, dir: f.dir, origin: 'https://example.invalid/resumed.git' });
    assert.equal(view('laptop')?.online, true);

    // A node that restarted, or names a session the office doesn't have, starts a new one.
    again.ws.terminate();
    await until(() => !view('laptop')?.online, 'the office to see it go again');
    const restarted = node('laptop', token);
    const fresh = await restarted.join({ session: 'not-one-of-ours', got: 7 });
    assert.equal(fresh.reply.t, 'welcome');
    const w = fresh.reply as Extract<Hello, { t: 'welcome' }>;
    assert.deepEqual([w.resumed, w.got], [false, 0]);
    assert.notEqual(w.session, session);
    // A new session opens every floor again.
    await until(() => restarted.told.some((m) => m.t === 'floor.open' && m.ch === f.ch), 'the floor again');
    fresh.ws.terminate();
    await until(() => !view('laptop')?.online, 'it to go');
  } finally {
    hub.removeRouter(f);
  }
});

test(
  "a node that comes back on a new session while its old socket hangs on isn't announced as gone",
  async (t) => {
    const token = registerNode(dir, 'desktop');
    const old = await node('desktop', token).join();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await node('desktop', token).join();
    // The office hangs up the old socket itself.
    await until(() => old.server.readyState === WebSocket.CLOSED, 'the old socket to close');
    notes.length = 0;
    t.mock.timers.tick(GRACE_MS);
    assert.equal(view('desktop')?.online, true);
    assert.deepEqual(notes, []);
  },
);

/** Stand-in for the office's end of a node's socket, for what a real socket can't show without crashing the test. */
function fakeSocket() {
  const sent: Hello[] = [];
  return Object.assign(new EventEmitter(), { sent, send: (raw: string) => sent.push(JSON.parse(raw)), close() {}, terminate() {} });
}

test(
  'a first message of `null` is refused, not thrown',
  () => {
    const ws = fakeSocket();
    hub.accept(ws as never);
    assert.doesNotThrow(() => ws.emit('message', Buffer.from('null')));
    assert.equal(ws.sent[0]?.t, 'refused');
  },
);

test(
  "a socket that errors before it says hello is dropped, not thrown",
  () => {
    const ws = fakeSocket();
    hub.accept(ws as never);
    try {
      assert.doesNotThrow(() => ws.emit('error', new RangeError('Max payload size exceeded')));
    } finally {
      ws.emit('message', Buffer.from('{}')); // clears accept's 10s hello timer
    }
  },
);

test('a new worker goes to the machine with the most memory to spare, until a node is full', async (t) => {
  t.mock.method(os, 'freemem', () => 8 * GiB); // the office's machine: 8 GiB, less the 1.5 GiB it keeps back
  const up: string[] = [];
  const f = floor('placing', (name) => up.push(name));
  hub.addRouter(f);
  t.after(() => hub.removeRouter(f));
  assert.equal(hub.place(f.ch), HOST);

  const big = node('big', registerNode(dir, 'big'));
  await big.join();
  await until(() => big.told.some((m) => m.t === 'floor.open' && m.ch === f.ch), 'the floor to open there');
  big.link.send({ t: 'stats', stats: stats() });
  await until(() => view('big')?.stats, 'its stats');
  assert.equal(hub.place(f.ch), HOST, "not before the node has the floor's project ready");
  big.link.send({ t: 'floor.ready', ch: f.ch, version: PTY_PROTOCOL, sessions: [] });
  await until(() => up.includes('big'), 'the floor to be ready there');
  assert.ok(hub.hostOn('big', f.ch));
  assert.equal(hub.place(f.ch), 'big');
  assert.equal(hub.place(floor('other').ch), HOST, 'only floors it has ready');

  // Each worker just sent there counts 700 MB until its stats show it.
  hub.placed('big');
  hub.placed('big');
  assert.equal(hub.place(f.ch), 'big'); // 8192 - 1400 MB > 8192 - 1536 MB
  hub.placed('big');
  assert.equal(hub.place(f.ch), HOST); // 8192 - 2100 MB < 8192 - 1536 MB

  // With memory to burn, it's how many workers it said it takes that stops it: 1 running + 3 just placed.
  const say = async (s: NodeStats) => {
    big.link.send({ t: 'stats', stats: s });
    await until(() => JSON.stringify(view('big')?.stats) === JSON.stringify(s), 'the new stats');
  };
  await say(stats({ memFree: 2 ** 50, workers: 1, maxWorkers: 5 }));
  assert.equal(hub.place(f.ch), 'big');
  await say(stats({ memFree: 2 ** 50, workers: 1, maxWorkers: 4 }));
  assert.equal(hub.place(f.ch), HOST);
  await say(stats({ memFree: 2 ** 50, workers: 1, maxWorkers: 0 }));
  assert.equal(hub.place(f.ch), 'big', 'no maximum set');
});

test("a floor's router sends a fresh agent in its own worktree to a node, with only the env the office set", async (t) => {
  const repo = path.join(dir, 'routed');
  mkdirSync(path.join(repo, '.agent-office'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/routed.git'], { cwd: repo });
  const workers = new Map<string, WorkerInfo>();
  const resumed: string[] = [];
  const router = new NodeRouter(path.join(repo, '.agent-office'), () => {}, {
    get: (id) => workers.get(id),
    list: () => [...workers.values()],
    resume: (id) => void resumed.push(id),
  });
  t.after(() => router.detach());
  // The office's own terminal host: what stays here is spawned into this instead of a real terminal.
  const local: { t: string; id: string; opts: SpawnOpts }[] = [];
  router.use(new Duplex({ read() {}, write: (chunk, _enc, cb) => (String(chunk).split('\n').forEach((l) => l && local.push(JSON.parse(l))), cb()) }), []);

  const token = registerNode(dir, 'far');
  const far = node('far', token);
  const joined = await far.join();
  await until(() => far.told.some((m) => m.t === 'floor.open' && m.ch === router.ch), 'the floor to open there');
  far.link.send({ t: 'stats', stats: stats({ memFree: 2 ** 50 }) });
  far.link.send({ t: 'floor.ready', ch: router.ch, version: PTY_PROTOCOL, sessions: [] });
  await until(() => hub.hostOn('far', router.ch), 'the floor to be ready there');

  let n = 0;
  const hire = (w: Partial<WorkerInfo> = {}) => {
    const id = `w${++n}`;
    const info = { id, kind: 'agent', deskId: 'desk-1', status: 'working', createdAt: Date.now(), worktree: { path: `.claude/worktrees/${id}`, branch: `office/${id}`, base: 'main', from: 'dev' }, ...w } as WorkerInfo;
    workers.set(id, info);
    return info;
  };
  const start = (w: WorkerInfo, env: Record<string, string> = {}) =>
    router.spawn({ file: 'claude', args: ['--resume'], cwd: repo, cols: 80, rows: 24, env: { ...childEnv(), AGENT_OFFICE_WORKER_ID: w.id, ...env } });
  const spawnedThere = (w: WorkerInfo) => far.told.filter((m) => m.t === 'pty' && m.m.t === 'spawn' && m.m.opts.env.AGENT_OFFICE_WORKER_ID === w.id).map((m) => (m as { m: { opts: SpawnOpts } }).m.opts);

  const signIns = { PATH: '/office/bin', CLAUDE_CONFIG_DIR: '/office/claude', GH_CONFIG_DIR: '/office/gh', GIT_CONFIG_GLOBAL: '/office/gitconfig', ANTHROPIC_API_KEY: 'sk-office', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-office', GH_TOKEN: 'gh-office', GITHUB_TOKEN: 'github-office' };
  const w = hire();
  start(w, { ...signIns, OFFICE_SET: 'this' });
  assert.equal(w.node, 'far');
  const opts = await until(() => spawnedThere(w)[0], 'the spawn to reach the node');
  // Not the office's PATH or sign-ins, and not what the node has of its own anyway.
  assert.deepEqual(opts.env, { AGENT_OFFICE_WORKER_ID: w.id, OFFICE_SET: 'this' });
  assert.deepEqual(opts.remote, { path: `.claude/worktrees/${w.id}`, branch: `office/${w.id}`, base: 'main', from: 'dev', envKeys: ['AGENT_OFFICE_WORKER_ID', 'OFFICE_SET'] });
  assert.deepEqual([opts.file, opts.args, opts.cols, opts.rows], ['claude', ['--resume'], 80, 24]);
  assert.equal(local.length, 0);

  // Anything else stays on the office's machine, however roomy the node.
  const stays: [string, Partial<WorkerInfo>][] = [
    ['a shell', { kind: 'shell' }],
    ['no worktree of its own', { worktree: undefined }],
    ['across repositories', { repos: [{ floor: 'x' } as never] }],
    ['in a meeting', { meeting: 'standup' }],
    ['at a station', { deskId: 'station-issues' }],
    ['hired over a minute ago', { createdAt: Date.now() - 61_000 }],
  ];
  for (const [why, over] of stays) {
    const s = hire(over);
    start(s);
    assert.equal(s.node, '', why);
    assert.equal(local.at(-1)?.opts.env.AGENT_OFFICE_WORKER_ID, s.id, why);
    assert.equal(local.at(-1)?.opts.remote, undefined, why);
  }

  // Where it started is where it starts again.
  start(w);
  await until(() => spawnedThere(w).length === 2, 'the second start there');
  const home = hire({ node: '' });
  start(home);
  assert.equal(local.at(-1)?.opts.env.AGENT_OFFICE_WORKER_ID, home.id);
  assert.throws(() => start(hire({ node: 'gone' })), /runs on gone, which isn't connected/);

  // A pin beats placement, once.
  hub.pin(router.ch, 'desk-7', HOST);
  const pinned = hire({ deskId: 'desk-7' });
  start(pinned);
  assert.equal(pinned.node, '');
  const next = hire({ deskId: 'desk-7' });
  start(next);
  assert.equal(next.node, 'far');
  hub.pin(router.ch, 'desk-8', 'gone');
  const away = hire({ deskId: 'desk-8' });
  assert.throws(() => start(away), /isn't connected/);
  assert.equal(away.node, 'gone', 'it waits for its node rather than moving');

  // Past start-up, the node coming back (a new session) ends terminals nobody claimed and resumes its exited workers.
  router.killUnclaimed();
  const exited = hire({ node: 'far', status: 'exited' });
  hire({ node: 'far', status: 'working' });
  hire({ node: '', status: 'exited' });
  // Its old socket goes first, so the office isn't left holding it (see the test above).
  joined.ws.terminate();
  await until(() => !view('far')?.online, 'it to go');
  const back = node('far', token);
  await back.join();
  await until(() => back.told.some((m) => m.t === 'floor.open' && m.ch === router.ch), 'the floor to open again');
  back.link.send({ t: 'floor.ready', ch: router.ch, version: PTY_PROTOCOL, sessions: ['left-over'] });
  await until(() => back.told.some((m) => m.t === 'pty' && m.m.t === 'kill' && m.m.id === 'left-over'), 'the left-over terminal to be ended');
  assert.deepEqual(resumed, [exited.id]);
});
