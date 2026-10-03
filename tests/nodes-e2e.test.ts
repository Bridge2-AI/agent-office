// A real office and a real node (`agent-office node`, in a process of its own with its own clone of
// the project): a worker hired onto the node runs there, in a worktree made from origin, reaches the
// office's workers through the node's relay, and its terminal works from the office.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { registerNode } from '../src/server/nodes/hub.js';
import type { ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

let tmp = '';
let office: Awaited<ReturnType<typeof startServer>>;
let node: ChildProcess | undefined;
let nodeLog = '';
let base = '';
let dataDir = '';
let ws: WebSocket;
const inbox: ServerMsg[] = [];
const PASSWORD = 'nodes-test';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(what: string, check: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\nnode log:\n${nodeLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const take = <T extends ServerMsg['t']>(t: T, ok: (m: Msg<T>) => boolean = () => true) => until(t, () => inbox.find((m) => m.t === t && ok(m as Msg<T>)) as Msg<T> | undefined);

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-office-nodes-'));
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const home = path.join(tmp, 'home');
  const origin = path.join(tmp, 'remote', 'origin.git');
  const project = path.join(tmp, 'project');
  const publicDir = path.join(tmp, 'public');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, origin, publicDir, path.join(publicDir, 'assets'), bin]) mkdirSync(d, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  git(['clone', '-q', origin, project], tmp);
  writeFileSync(path.join(project, 'README.md'), '# nodes\n');
  git(['add', '.'], project);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], project);
  git(['push', '-q', 'origin', 'main'], project);
  for (const page of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  // The worker: says where it runs, asks the office who's at their desks, then echoes what it's typed.
  const agent = path.join(bin, 'fake-agent');
  writeFileSync(agent, '#!/bin/sh\npwd > .node-ran\necho "start $(date +%s) $$" >> .node-starts\noffice-workers list > .node-workers 2>&1\necho fake-agent-ready\nexec cat\n');
  chmodSync(agent, 0o755);

  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  const port = await freePort();
  const cfg = loadConfig([project, '--home', home, '--projects', path.join(tmp, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', agent]);
  office = await startServer(cfg, { publicDir });
  base = `http://127.0.0.1:${port}`;

  dataDir = cfg.dataDir;
  const token = registerNode(dataDir, 'lent');
  const cli = path.resolve('src/server/cli.ts');
  node = spawn(process.execPath, ['--import', 'tsx', cli, 'node', '--office', base, '--name', 'lent', '--token', token, '--projects', path.join(tmp, 'node')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  node.stdout!.on('data', (d) => (nodeLog += d));
  node.stderr!.on('data', (d) => (nodeLog += d));

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, origin: base } });
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
});

after(async () => {
  ws?.close();
  node?.kill();
  office?.shutdown();
  // The node's terminal host ends its terminals once the node's office link is gone for good; don't wait on it.
  await new Promise((r) => setTimeout(r, 200));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('a worker pinned to a node runs there and its terminal works from the office', async () => {
  await take('welcome');
  // The node joined, cloned the project and has its terminal host up for this floor.
  await take('nodes', (m) => m.nodes.some((n) => n.name === 'lent' && n.online && !!n.stats));
  await until('the node to have the floor ready', () => /joined the office/.test(nodeLog) && existsSync(path.join(tmp, 'node', 'remote', 'origin', '.agent-office', 'bin')));

  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-1', prompt: 'hello', worktree: true, node: 'lent' }));
  const update = await take('worker.update', (m) => m.worker.node === 'lent' && m.worker.status !== 'exited');
  const worker: WorkerInfo = update.worker;
  assert.ok(worker.worktree, 'it got a worktree');

  // It ran on the node, in the node's own worktree of the project.
  const where = path.join(tmp, 'node', 'remote', 'origin', worker.worktree!.path);
  const ran = await until('the worker to run on the node', () => existsSync(path.join(where, '.node-ran')) && readFileSync(path.join(where, '.node-ran'), 'utf8').trim());
  assert.equal(ran, where);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: where, encoding: 'utf8' }).trim(), worker.worktree!.branch);
  // office-workers reached the office through the node's relay, with the worker's own token.
  const listed = await until('office-workers to answer', () => {
    const f = path.join(where, '.node-workers');
    const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
    return text.includes(worker.name) && text;
  });
  assert.match(listed, new RegExp(worker.name));

  // Typing in the office reaches the process on the node, and its output comes back.
  ws.send(JSON.stringify({ t: 'worker.attach', workerId: worker.id }));
  await take('term.snapshot', (m) => m.workerId === worker.id);
  ws.send(JSON.stringify({ t: 'term.input', workerId: worker.id, data: 'ping-from-office\r' }));
  await take('term.data', (m) => m.workerId === worker.id && m.data.includes('ping-from-office'));

  ws.send(JSON.stringify({ t: 'worker.kill', workerId: worker.id }));
  await take('worker.remove', (m) => m.workerId === worker.id);
});

test('Auto puts a worktree worker on the machine with the most memory to spare, and the rest on the office', async () => {
  // Same machine here, but the office keeps memory back for itself: the node has more to spare.
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-2', prompt: 'auto', worktree: true }));
  const auto = await take('worker.update', (m) => m.worker.deskId === 'desk-2' && m.worker.node !== undefined);
  assert.equal(auto.worker.node, 'lent');
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-3', prompt: 'here', worktree: false, node: 'lent' }));
  const here = await take('worker.update', (m) => m.worker.deskId === 'desk-3' && m.worker.node !== undefined);
  assert.equal(here.worker.node, '', 'only a worker in its own worktree can run elsewhere');
});

test("a node that restarts gets its workers back", async () => {
  const before = await take('worker.update', (m) => m.worker.deskId === 'desk-2' && m.worker.status !== 'starting');
  const where = path.join(tmp, 'node', 'remote', 'origin', before.worker.worktree!.path);
  await until('the auto worker to run', () => existsSync(path.join(where, '.node-ran')));
  rmSync(path.join(where, '.node-ran'));
  const token = registerNode(dataDir, 'lent');
  node!.kill('SIGKILL');
  nodeLog = '';
  inbox.length = 0;
  node = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/server/cli.ts'), 'node', '--office', base, '--name', 'lent', '--token', token, '--projects', path.join(tmp, 'node')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` } });
  node.stdout!.on('data', (d) => (nodeLog += d));
  node.stderr!.on('data', (d) => (nodeLog += d));
  // Its terminal starts again on the node, in the same worktree.
  await until('the worker to start again on the node', () => existsSync(path.join(where, '.node-ran')), 30_000);
  await take('worker.update', (m) => m.worker.id === before.worker.id && m.worker.node === 'lent' && m.worker.status !== 'exited');
  const pids = readFileSync(path.join(where, '.node-starts'), 'utf8').trim().split('\n').map((l) => l.split(' ')[2]);
  assert.equal(new Set(pids).size, 2, 'a new process, not the one from before the node went down');
});
