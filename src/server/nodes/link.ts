import type { WebSocket } from 'ws';
import { MAX_UNACKED_BYTES, type Frame } from './wire.js';

const ACK_MS = 1000;

/**
 * Messages between the office and a node that survive the WebSocket under them dropping: each is
 * numbered and kept until the other side says it has it, so a laptop's Wi-Fi blinking resends what
 * was in flight instead of losing a piece of a terminal. Both ends use one.
 */
export class Link<Out, In> {
  private ws: WebSocket | null = null;
  private sent = 0;
  private got = 0;
  private acked = 0;
  private unacked: { s: number; json: string }[] = [];
  private unackedBytes = 0;
  private ackTimer: NodeJS.Timeout;
  private lastAck = 0;
  closed = false;

  constructor(
    private onMessage: (m: In) => void,
    /** Too much unacknowledged: the session is beyond saving. */
    private onOverflow: () => void,
  ) {
    this.ackTimer = setInterval(() => this.sendAck(), ACK_MS).unref();
  }

  /** How far this side has got with the other's messages, for the other to resend from. */
  get received(): number {
    return this.got;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === this.ws.OPEN;
  }

  /** Puts the link on `ws`, resending whatever the other side (which has got as far as `peerGot`) is missing. */
  bind(ws: WebSocket, peerGot: number) {
    this.ws = ws;
    this.drop(peerGot);
    ws.on('message', (raw) => this.receive(String(raw)));
    for (const f of this.unacked) ws.send(f.json);
  }

  /** The WebSocket under it went away; messages queue until the next bind. */
  unbind(ws: WebSocket) {
    if (this.ws === ws) this.ws = null;
  }

  send(m: Out) {
    if (this.closed) return;
    const s = ++this.sent;
    const json = JSON.stringify({ s, m } satisfies Frame<Out>);
    this.unacked.push({ s, json });
    this.unackedBytes += json.length;
    if (this.unackedBytes > MAX_UNACKED_BYTES) {
      this.close();
      this.onOverflow();
      return;
    }
    if (this.connected) this.ws!.send(json);
  }

  close() {
    this.closed = true;
    clearInterval(this.ackTimer);
    this.unacked = [];
    this.unackedBytes = 0;
  }

  private receive(raw: string) {
    let f: Frame<In>;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (!f || typeof f !== 'object') return;
    if ('a' in f) return this.drop(f.a);
    // Resent after a reconnect, and already handled.
    if (f.s <= this.got) return;
    this.got = f.s;
    this.onMessage(f.m);
  }

  private drop(upTo: number) {
    if (upTo <= this.acked) return;
    this.acked = upTo;
    while (this.unacked.length && this.unacked[0].s <= upTo) this.unackedBytes -= this.unacked.shift()!.json.length;
  }

  private sendAck() {
    if (this.got === this.lastAck || !this.connected) return;
    this.lastAck = this.got;
    this.ws!.send(JSON.stringify({ a: this.got } satisfies Frame<Out>));
  }
}
