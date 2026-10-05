import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Accounts } from '../src/server/accounts.js';
import { Auth } from '../src/server/auth.js';
import { ensureSelfSigned, type Config } from '../src/server/config.js';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { authRoutes } from '../src/server/http/routes/auth.js';
import { nodeConnectRoutes } from '../src/server/http/routes/node-connect.js';
import { connectionCommand } from '../src/server/nodes/enrollment.js';
import { HOST, hub, registeredNodes, registerNode } from '../src/server/nodes/hub.js';
import { shq } from '../src/server/workers/process.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-enroll-'));
const accounts = new Accounts(dir);
const auth = new Auth(randomBytes(32), randomBytes(16), 'test-secret', accounts);
const cfg = { dataDir: dir, trustProxy: false, port: 0 } as Config;
const ctx = { cfg, accounts, auth, accountsChanged() {}, officeName: 'test', services: { lookup() {} } } as unknown as Ctx;
const server = http.createServer(requestHandler(ctx, [authRoutes.join, ...Object.values(nodeConnectRoutes)]));
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws)));
let base = '';
const children: ChildProcess[] = [];
let nodeLog = '';

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cfg.port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${cfg.port}`;
  hub.init(dir, 9, () => {}, () => {});
  writeFileSync(path.join(dir, 'connect-node.html'), '<title>Connect your machine</title>');
  ctx.publicDir = dir;
});

after(async () => {
  hub.shutdown();
  for (const child of children) child.kill();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const get = (cookie = '') => fetch(`${base}/api/node-connect`, { headers: { cookie } });
const post = (body: unknown, cookie = '', origin = base, type = 'application/json') =>
  fetch(`${base}/api/node-connect`, { method: 'POST', headers: { cookie, origin, 'content-type': type }, body: JSON.stringify(body) });

async function join(name: string) {
  const invite = accounts.invite('admin', 'member', name);
  assert.notEqual(typeof invite, 'string');
  const res = await fetch(`${base}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: (invite as { token: string }).token, password: 'test-password' }),
  });
  assert.equal(res.status, 200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], account: accounts.byName(name)! };
}

async function until(check: () => boolean, message: string) {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < end, `${message}\n${nodeLog}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('an invite offers optional, isolated enrollment; its command connects a real node and revocation disconnects it', { skip: process.platform === 'win32' }, async (t) => {
  assert.equal((await get()).status, 401);
  assert.equal((await post({ consent: true, maxWorkers: 1 })).status, 401);
  const alice = await join('Alice');
  const shared = auth.cookie({ headers: { host: `127.0.0.1:${cfg.port}` } } as http.IncomingMessage, auth.issue(), false).split(';')[0];
  assert.equal((await get(shared)).status, 403);
  const page = await fetch(`${base}/connect-node`, { headers: { cookie: alice.cookie } });
  assert.match(await page.text(), /Connect your machine/);
  const info = await (await get(alice.cookie)).json();
  assert.equal(info.registered, false);
  assert.deepEqual(registeredNodes(dir), [], 'opening the optional step registers nothing');

  assert.equal((await post({ consent: true, maxWorkers: 1 }, alice.cookie, 'https://evil.example')).status, 403);
  assert.equal((await post({ consent: true, maxWorkers: 1 }, alice.cookie, base, 'text/plain')).status, 400);
  assert.equal((await post({ consent: false, maxWorkers: 1 }, alice.cookie)).status, 400);
  for (const maxWorkers of [0, -1, 1.5, 501, null]) assert.equal((await post({ consent: true, maxWorkers }, alice.cookie)).status, 400);
  assert.deepEqual(registeredNodes(dir), []);

  const res = await post({ consent: true, maxWorkers: 2 }, alice.cookie);
  assert.equal(res.status, 200);
  const connection = await res.json();
  assert.match(connection.command, /--max-workers 2/);
  assert.ok(connection.command.includes(shq(base)));
  assert.equal(connection.name, `member-${alice.account.id}`);
  const original = registeredNodes(dir)[0];
  assert.equal(original.accountId, alice.account.id);
  assert.ok(!readFileSync(path.join(dir, 'nodes.json'), 'utf8').includes(/--token (\w+)/.exec(connection.command)![1]));
  assert.equal((await post({ consent: true, maxWorkers: 2 }, alice.cookie)).status, 409, 'a retry cannot silently rekey a node');

  const bob = await join('Bob');
  const bobRes = await post({ consent: true, maxWorkers: 1, name: connection.name, replace: true }, bob.cookie);
  assert.equal(bobRes.status, 200);
  assert.notEqual((await bobRes.json()).name, connection.name);
  assert.equal(registeredNodes(dir).find((n) => n.name === connection.name)?.hash, original.hash, 'another member cannot rekey Alice');

  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  mkdirSync(project);
  mkdirSync(bin);
  const git = (args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(project, 'README.md'), '# enrolled\n');
  git(['add', '.']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);
  const cli = path.resolve('src/server/cli.ts');
  const wrapper = path.join(bin, 'agent-office');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shq(process.execPath)} --import tsx ${shq(cli)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const floor = { ch: path.join(project, '.agent-office'), dir: project, origin: () => project, nodeUp() {} };
  hub.addRouter(floor);
  t.after(() => hub.removeRouter(floor));
  const run = (command: string) => {
    const child = spawn('/bin/sh', ['-c', `exec ${command} --projects ${shq(path.join(dir, 'node-projects'))}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout!.on('data', (chunk) => (nodeLog += chunk));
    child.stderr!.on('data', (chunk) => (nodeLog += chunk));
    return child;
  };
  const first = run(connection.command);
  await until(() => !!hub.hostOn(connection.name, floor.ch) && !!hub.list().find((n) => n.name === connection.name)?.stats, 'generated command connects and readies the project');
  assert.equal(hub.list().find((n) => n.name === connection.name)?.stats?.maxWorkers, 2);
  t.mock.method(os, 'freemem', () => 0);
  assert.equal(hub.place(floor.ch), connection.name, 'Auto can use the invited machine');

  const replacement = await (await post({ consent: true, maxWorkers: 1, replace: true }, alice.cookie)).json();
  assert.notEqual(replacement.command, connection.command);
  await until(() => !hub.hostOn(connection.name, floor.ch), 'replacement disconnects the old node');
  assert.equal(hub.place(floor.ch), HOST);
  first.kill();
  run(replacement.command);
  await until(() => !!hub.hostOn(connection.name, floor.ch), 'replacement command works');
  accounts.revoke(alice.account.id);
  await until(() => !hub.hostOn(connection.name, floor.ch), 'revoked account loses its node');
  assert.equal((await get(alice.cookie)).status, 401);
  assert.equal((await post({ consent: true, maxWorkers: 1, replace: true }, alice.cookie)).status, 401);
  assert.equal(hub.list().find((n) => n.name === connection.name), undefined);
  assert.equal(hub.place(floor.ch), HOST);
});

test('connection commands preserve forwarded ports and IPv6, pin direct TLS, and trust proxy TLS normally', async () => {
  assert.ok(connectionCommand(cfg, 'http://localhost:49123', 'node', 'token', 1).includes("--office 'http://localhost:49123'"));
  assert.ok(connectionCommand(cfg, 'http://[::1]:49123', 'node', 'token', 1).includes("--office 'http://[::1]:49123'"));
  const tlsCfg = { ...cfg, tls: { cert: '', key: '' } };
  await ensureSelfSigned(tlsCfg);
  const pinned = connectionCommand(tlsCfg, 'https://office.example:4600', 'node', 'token', 1);
  assert.ok(pinned.includes(`--pin sha256:${new X509Certificate(tlsCfg.tls.cert).fingerprint256}`));
  assert.ok(!connectionCommand({ ...tlsCfg, trustProxy: true }, 'https://office.example', 'node', 'token', 1).includes('--pin'));
  assert.throws(() => connectionCommand(cfg, 'ftp://office.example', 'node', 'token', 1));
  const operatorToken = registerNode(dir, 'operator-node');
  assert.equal(typeof operatorToken, 'string');
  assert.ok(hub.list().some((n) => n.name === 'operator-node'), 'operator nodes do not need account ownership');
});
