// A real office and a real node (`agent-office node`, in a process of its own with its own clone of
// the project): a worker hired onto the node runs there, in a worktree made from origin, reaches the
// office's workers through the node's relay, its terminal works from the office, and it moves
// between the two, work and conversation and all.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { hub, registerNode } from '../src/server/nodes/hub.js';
import type { ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

let tmp = '';
let office: Awaited<ReturnType<typeof startServer>>;
let node: ChildProcess | undefined;
let nodeLog = '';
let base = '';
let dataDir = '';
let cfg: ReturnType<typeof loadConfig>;
let publicDir = '';
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
    if (Date.now() > end) {
      const seen = inbox.filter((m) => m.t === 'worker.update' || m.t === 'toast').slice(-6).map((m) => JSON.stringify(m.t === 'toast' ? m : { s: m.worker.status, node: m.worker.node, act: m.worker.activity, exit: m.worker.exitCode }));
      throw new Error(`timed out waiting for ${what}\nlast seen:\n${seen.join('\n')}\nnode log:\n${nodeLog}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const take = <T extends ServerMsg['t']>(t: T, ok: (m: Msg<T>) => boolean = () => true) => until(t, () => inbox.find((m) => m.t === t && ok(m as Msg<T>)) as Msg<T> | undefined);

const nodeEnv = () => ({ ...process.env, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-node') });

/** A browser's WebSocket, signed in, with everything it's sent collected in `inbox`. */
async function signIn() {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, origin: base } });
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-office-nodes-'));
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const home = path.join(tmp, 'home');
  const origin = path.join(tmp, 'remote', 'origin.git');
  const project = path.join(tmp, 'project');
  publicDir = path.join(tmp, 'public');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, origin, publicDir, path.join(publicDir, 'assets'), bin]) mkdirSync(d, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  git(['clone', '-q', origin, project], tmp);
  writeFileSync(path.join(project, 'README.md'), '# nodes\n');
  git(['add', '.'], project);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], project);
  git(['push', '-q', 'origin', 'main'], project);
  for (const page of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  // The worker: says where it runs, asks the office who's at their desks, keeps a conversation where
  // Claude Code would (carried on, if one is already there) and says so as Claude Code's hooks do,
  // then echoes what it's typed.
  const agent = path.join(bin, 'fake-agent');
  writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'pwd > .node-ran',
      'echo "start $(date +%s) $$" >> .node-starts',
      'office-workers list > .node-workers 2>&1',
      'SID="sess-$AGENT_OFFICE_WORKER_ID"',
      'DIR="$CLAUDE_CONFIG_DIR/projects/$(pwd -P | sed \'s/[^a-zA-Z0-9]/-/g\')"',
      'mkdir -p "$DIR"',
      'if [ -f "$DIR/$SID.jsonl" ]; then echo "{\\"resumed\\":\\"$(pwd -P)\\"}" >> "$DIR/$SID.jsonl"; else echo "{\\"cwd\\":\\"$(pwd -P)\\",\\"said\\":\\"hello\\"}" > "$DIR/$SID.jsonl"; fi',
      'curl -s -o /dev/null -X POST -H "Authorization: Bearer $AGENT_OFFICE_HOOK_TOKEN" -H "content-type: application/json" -d "{\\"session_id\\":\\"$SID\\"}" "$AGENT_OFFICE_HOOK_URL/hooks/claude?worker=$AGENT_OFFICE_WORKER_ID&event=SessionStart"',
      'echo fake-agent-ready',
      'exec cat',
      '',
    ].join('\n'),
  );
  chmodSync(agent, 0o755);
  // Each machine's Claude Code keeps its conversations in a folder of its own.
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-office');

  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  const port = await freePort();
  cfg = loadConfig([project, '--home', home, '--projects', path.join(tmp, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', agent]);
  office = await startServer(cfg, { publicDir });
  base = `http://127.0.0.1:${port}`;

  dataDir = cfg.dataDir;
  const token = registerNode(dataDir, 'lent');
  const cli = path.resolve('src/server/cli.ts');
  node = spawn(process.execPath, ['--import', 'tsx', cli, 'node', '--office', base, '--name', 'lent', '--token', token, '--projects', path.join(tmp, 'node')], { stdio: ['ignore', 'pipe', 'pipe'], env: nodeEnv() });
  node.stdout!.on('data', (d) => (nodeLog += d));
  node.stderr!.on('data', (d) => (nodeLog += d));

  await signIn();
});

after(async () => {
  ws?.close();
  // The office first: its stop reaches the node's terminal host while the node is still connected.
  office?.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  node?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Terminals run in a host process of their own, which Windows doesn't have (see PtyHost.open).
const skip = process.platform === 'win32';

test('a worker pinned to a node runs there and its terminal works from the office', { skip }, async () => {
  await take('welcome');
  // The node joined, cloned the project and has its terminal host up for this floor.
  await take('nodes', (m) => m.nodes.some((n) => n.name === 'lent' && n.online && !!n.stats));
  await until('the node to have the floor ready', () => hub.hostOn('lent', path.join(office.floors()[0].dir, '.agent-office')));

  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-1', prompt: 'hello', worktree: true, node: 'lent' }));
  const update = await take('worker.update', (m) => m.worker.node === 'lent' && m.worker.status !== 'exited');
  const worker: WorkerInfo = update.worker;
  assert.ok(worker.worktree, 'it got a worktree');

  // It ran on the node, in the node's own worktree of the project.
  const where = path.join(tmp, 'node', 'remote', 'origin', worker.worktree!.path);
  const ran = await until('the worker to run on the node', () => existsSync(path.join(where, '.node-ran')) && readFileSync(path.join(where, '.node-ran'), 'utf8').trim());
  assert.equal(ran, realpathSync(where));
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

test('Auto puts a worktree worker on the machine with the most memory to spare, and the rest on the office', { skip }, async () => {
  // Same machine here, but the office keeps memory back for itself: the node has more to spare.
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-2', prompt: 'auto', worktree: true }));
  const auto = await take('worker.update', (m) => m.worker.deskId === 'desk-2' && m.worker.node !== undefined);
  assert.equal(auto.worker.node, 'lent');
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-3', prompt: 'here', worktree: false, node: 'lent' }));
  const here = await take('worker.update', (m) => m.worker.deskId === 'desk-3' && m.worker.node !== undefined);
  assert.equal(here.worker.node, '', 'only a worker in its own worktree can run elsewhere');
});

test("a node that restarts gets its workers back", { skip }, async () => {
  const before = await take('worker.update', (m) => m.worker.deskId === 'desk-2' && m.worker.status !== 'starting');
  const where = path.join(tmp, 'node', 'remote', 'origin', before.worker.worktree!.path);
  await until('the auto worker to run', () => existsSync(path.join(where, '.node-ran')));
  const token = registerNode(dataDir, 'lent');
  node!.kill('SIGKILL');
  nodeLog = '';
  inbox.length = 0;
  node = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/server/cli.ts'), 'node', '--office', base, '--name', 'lent', '--token', token, '--projects', path.join(tmp, 'node')], { stdio: ['ignore', 'pipe', 'pipe'], env: nodeEnv() });
  node.stdout!.on('data', (d) => (nodeLog += d));
  node.stderr!.on('data', (d) => (nodeLog += d));
  // Its terminal starts again on the node, in the same worktree.
  const pids = () => readFileSync(path.join(where, '.node-starts'), 'utf8').trim().split('\n').map((l) => l.split(' ')[2]);
  await until('the worker to start again on the node', () => pids().length > 1, 30_000);
  await take('worker.update', (m) => m.worker.id === before.worker.id && m.worker.node === 'lent' && m.worker.status !== 'exited');
  assert.equal(new Set(pids()).size, 2, 'a new process, not the one from before the node went down');
});

test('an office that restarts picks its workers on a node back up, still running', { skip }, async () => {
  const w = (await take('worker.update', (m) => m.worker.deskId === 'desk-2' && m.worker.node === 'lent')).worker;
  const where = path.join(tmp, 'node', 'remote', 'origin', w.worktree!.path);
  const starts = () => readFileSync(path.join(where, '.node-starts'), 'utf8').trim().split('\n').length;
  const before = starts();
  ws.close();
  office.shutdown(true); // a restart, as an upgrade does
  for (let i = 0; ; i++) {
    try {
      office = await startServer(cfg, { publicDir });
      break;
    } catch (err) {
      if (i > 20) throw err; // the old one is still letting go of the port
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  inbox.length = 0;
  await signIn();
  await take('nodes', (m) => m.nodes.some((n) => n.name === 'lent' && n.online));
  // Its terminal is the same process, picked back up: typing still reaches it.
  ws.send(JSON.stringify({ t: 'worker.attach', workerId: w.id }));
  await take('term.snapshot', (m) => m.workerId === w.id);
  ws.send(JSON.stringify({ t: 'term.input', workerId: w.id, data: 'after-restart\r' }));
  await take('term.data', (m) => m.workerId === w.id && m.data.includes('after-restart'));
  assert.equal(starts(), before, 'not started again');
});

/** Where the fake agent keeps a worker's conversation, in `config`, for a worker in `cwd`. */
const conversation = (config: string, cwd: string, id: string) => path.join(tmp, config, 'projects', realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `sess-${id}.jsonl`);

test('a worker moves from a node to the office and back, its work and its conversation with it', { skip }, async () => {
  inbox.length = 0;
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'desk-4', prompt: 'move me', worktree: true, node: 'lent' }));
  const w = (await take('worker.update', (m) => m.worker.deskId === 'desk-4' && m.worker.node === 'lent')).worker;
  const onNode = path.join(tmp, 'node', 'remote', 'origin', w.worktree!.path);
  const inOffice = path.join(tmp, 'project', w.worktree!.path);
  // Its session, as its hook told the office (which says nothing of it to browsers).
  await until('its session to be known', () => office.floors()[0].workers.get(w.id)?.sessionId);
  assert.ok(existsSync(conversation('claude-node', onNode, w.id)));
  writeFileSync(path.join(onNode, 'made-on-node.txt'), 'work in progress\n');

  // To the office: its work comes with it, committed, and its conversation, in the office's folder for it.
  inbox.length = 0;
  ws.send(JSON.stringify({ t: 'worker.move', workerId: w.id, node: 'host' }));
  await take('toast', (m) => /is on the office's machine now/.test(m.text));
  assert.equal(readFileSync(path.join(inOffice, 'made-on-node.txt'), 'utf8'), 'work in progress\n');
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: inOffice, encoding: 'utf8' }), /^wip: .* moves to the office/);
  const here = await until('it to carry on in the office', () => {
    const f = conversation('claude-office', inOffice, w.id);
    const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
    return text.includes('resumed') && text;
  });
  // The folder it worked in there is this one here, all through it.
  assert.ok(here.includes(`"cwd":"${realpathSync(inOffice)}"`), here);
  assert.ok(!here.includes(realpathSync(onNode)), here);
  await take('worker.update', (m) => m.worker.id === w.id && m.worker.node === '' && m.worker.status !== 'exited');

  // And back to the node, with what it said in the office.
  writeFileSync(path.join(inOffice, 'made-in-office.txt'), 'more\n');
  inbox.length = 0;
  ws.send(JSON.stringify({ t: 'worker.move', workerId: w.id, node: 'lent' }));
  await take('toast', (m) => /is on lent now/.test(m.text));
  assert.equal(readFileSync(path.join(onNode, 'made-in-office.txt'), 'utf8'), 'more\n');
  const back = await until('it to carry on on the node', () => {
    const text = readFileSync(conversation('claude-node', onNode, w.id), 'utf8');
    return text.split('resumed').length === 3 && text;
  });
  assert.ok(back.includes(`"resumed":"${realpathSync(onNode)}"`), back);
  assert.ok(!back.includes(realpathSync(inOffice)), back);
});

test("a worker isn't moved to where it already is", { skip }, async () => {
  const w = (await take('worker.update', (m) => m.worker.deskId === 'desk-4')).worker;
  inbox.length = 0;
  ws.send(JSON.stringify({ t: 'worker.move', workerId: w.id, node: 'lent' }));
  await take('toast', (m) => /already runs on lent/.test(m.text));
});
