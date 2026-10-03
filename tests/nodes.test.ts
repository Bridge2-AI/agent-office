// Nodes (docs/nodes.md), the parts that need no node connected: the Link that carries the office's and
// a node's messages over a WebSocket that may drop, the registry of who may connect (nodes.json),
// and the pins that send a hire at a desk to a machine. The handshake, placement and the floor
// router are in nodes-hub.test.ts, with a node connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST, hub, registerNode, registeredNodes, unregisterNode } from '../src/server/nodes/hub.js';
import { Link } from '../src/server/nodes/link.js';
import { MAX_UNACKED_BYTES } from '../src/server/nodes/wire.js';

/** A WebSocket server on loopback, and a way to open a connection to it with both its ends in hand. */
async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return {
    async pair(): Promise<[office: WebSocket, node: WebSocket]> {
      const office = once(wss, 'connection');
      const node = new WebSocket(url);
      await once(node, 'open');
      return [(await office)[0] as WebSocket, node];
    },
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(resolve));
    },
  };
}

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

/** Just enough of a ws WebSocket for a Link to bind to: one that is never open, so nothing goes out. */
const closedSocket = () => Object.assign(new EventEmitter(), { readyState: WebSocket.CLOSED, OPEN: WebSocket.OPEN, send() {} }) as unknown as WebSocket;

/** The numbered frames that come in on `ws`, as they come. */
function framesOn(ws: WebSocket): number[] {
  const seen: number[] = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw));
    if ('s' in f) seen.push(f.s);
  });
  return seen;
}

test('a link delivers in order, and a dropped socket loses and repeats nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // each side's 1s ack, ticked by hand
  const net = await server();
  const atNode: number[] = [];
  const atOffice: string[] = [];
  const office = new Link<number, string>((m) => atOffice.push(m), () => assert.fail('the office side overflowed'));
  const node = new Link<string, number>((m) => atNode.push(m), () => assert.fail('the node side overflowed'));
  try {
    let [a, b] = await net.pair();
    office.bind(a, 0);
    node.bind(b, 0);
    assert.ok(office.connected && node.connected);
    for (let i = 1; i <= 5; i++) office.send(i);
    node.send('a');
    await until(() => atNode.length === 5 && atOffice.length === 1, 'the first messages');
    assert.deepEqual(atNode, [1, 2, 3, 4, 5]);
    assert.equal(node.received, 5);
    assert.equal(office.received, 1);

    // The node's ack timer says it has 1..5, and the office can forget them.
    const ack = once(a, 'message');
    t.mock.timers.tick(1000);
    assert.deepEqual(JSON.parse(String((await ack)[0])), { a: 5 });
    // Nothing new since: no second ack.
    let more = 0;
    a.on('message', () => more++);
    t.mock.timers.tick(1000);

    // The socket dies mid-stream: 6 goes out as it does, 7 and 'b' after.
    office.send(6);
    b.terminate();
    office.send(7);
    node.send('b');
    await until(() => !office.connected && !node.connected, 'both ends to see the drop');
    office.unbind(a);
    node.unbind(b);
    assert.equal(more, 0);
    // While there's no socket at all, they queue.
    office.send(8);
    node.send('c');

    // Back on a new socket. The office is told the node has nothing (a stale count), so only what
    // the node never acknowledged can come again: 6..8, never 1..5.
    [a, b] = await net.pair();
    const resent = framesOn(b);
    node.bind(b, office.received);
    office.bind(a, 0);
    await until(() => atNode.length === 8 && atOffice.length === 3, 'what was missed');
    assert.deepEqual(atNode, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(atOffice, ['a', 'b', 'c']);
    assert.deepEqual(resent, [6, 7, 8]);

    // Another drop, and 6..8 (still unacknowledged) come a third time: the node takes them once.
    b.terminate();
    await until(() => !office.connected, 'the second drop');
    [a, b] = await net.pair();
    const third = framesOn(b);
    node.bind(b, office.received);
    office.bind(a, 0);
    office.send(9);
    await until(() => third.includes(9), 'the next message');
    assert.deepEqual(third, [6, 7, 8, 9]);
    assert.deepEqual(atNode, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally {
    office.close();
    node.close();
    await net.close();
  }
});

test("a link gives up once more than MAX_UNACKED_BYTES haven't been acknowledged", () => {
  let overflows = 0;
  const link = new Link<string, never>(() => {}, () => overflows++);
  const half = 'x'.repeat(MAX_UNACKED_BYTES / 2);
  link.send(half);
  assert.equal(overflows, 0);
  // Two halves and the frames around them: over.
  link.send(half);
  assert.equal(overflows, 1);
  assert.equal(link.closed, true);
  link.send('more');
  assert.equal(overflows, 1, 'a closed link sends nothing more and overflows once');
});

test("what the other side has doesn't count toward a link's limit", () => {
  let overflows = 0;
  const link = new Link<string, never>(() => {}, () => overflows++);
  try {
    const most = 'x'.repeat(MAX_UNACKED_BYTES * 0.6);
    link.send(most);
    // The other end comes back having got it: it's dropped, and another as big still fits.
    link.bind(closedSocket(), 1);
    link.send(most);
    assert.equal(overflows, 0);
  } finally {
    link.close();
  }
});

test(
  'a frame that is not an object is ignored, not thrown',
  () => {
    const ws = closedSocket();
    const got: unknown[] = [];
    const link = new Link<never, unknown>((m) => got.push(m), () => {});
    link.bind(ws, 0);
    try {
      for (const bad of ['null', '5', '"x"', 'not json']) assert.doesNotThrow(() => ws.emit('message', Buffer.from(bad)), bad);
      ws.emit('message', Buffer.from(JSON.stringify({ s: 1, m: 'fine' })));
      assert.deepEqual(got, ['fine']);
    } finally {
      link.close();
    }
  },
);

test("nodes.json keeps a hash of each node's token, never the token", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-nodes-'));
  try {
    assert.deepEqual(registeredNodes(dir), []);
    const token = registerNode(dir, 'laptop');
    assert.match(token, /^[0-9a-f]{48}$/);
    const file = path.join(dir, 'nodes.json');
    assert.ok(!readFileSync(file, 'utf8').includes(token));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    assert.equal(registeredNodes(dir)[0].hash, sha(token));

    // Adding it again re-keys it rather than listing it twice.
    const rekeyed = registerNode(dir, 'laptop');
    assert.notEqual(rekeyed, token);
    registerNode(dir, 'desktop');
    assert.deepEqual(registeredNodes(dir).map((n) => n.name), ['laptop', 'desktop']);
    assert.equal(registeredNodes(dir)[0].hash, sha(rekeyed));

    assert.equal(unregisterNode(dir, 'laptop'), true);
    assert.equal(unregisterNode(dir, 'laptop'), false);
    assert.deepEqual(registeredNodes(dir).map((n) => n.name), ['desktop']);

    // A nodes.json that isn't one lists nobody.
    writeFileSync(file, '{"nodes": 3');
    assert.deepEqual(registeredNodes(dir), []);
    writeFileSync(file, '{"nodes": {}}');
    assert.deepEqual(registeredNodes(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pin sends one hire at a desk to a machine, and is used up by it', () => {
  const a = '/projects/a/.agent-office';
  const b = '/projects/b/.agent-office';
  hub.pin(a, 'desk-1', 'laptop');
  hub.pin(b, 'desk-1', HOST);
  assert.equal(hub.takePin(a, 'desk-2'), undefined);
  assert.equal(hub.takePin(a, 'desk-1'), 'laptop');
  assert.equal(hub.takePin(a, 'desk-1'), undefined);
  assert.equal(hub.takePin(b, 'desk-1'), HOST, "each floor's desks are its own");
  // Picking Auto again takes the pin off.
  hub.pin(a, 'desk-3', 'laptop');
  hub.pin(a, 'desk-3', undefined);
  assert.equal(hub.takePin(a, 'desk-3'), undefined);
});

test("with no node connected, every worker stays on the office's machine", () => {
  assert.equal(hub.place('/projects/a/.agent-office'), HOST);
});
