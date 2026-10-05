import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Accounts } from '../accounts.js';

export interface Registered {
  name: string;
  hash: string;
  addedAt: number;
  accountId?: string;
}

export const nodeTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function read(file: string | undefined): Registered[] {
  if (!file) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')).nodes;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function authorizedNodes(file: string | undefined): Registered[] {
  const nodes = read(file);
  if (!file || !nodes.some((n) => n.accountId)) return nodes;
  const accounts = new Accounts(path.dirname(file));
  return nodes.filter((n) => !n.accountId || accounts.get(n.accountId));
}

export function registerNode(dataDir: string, name: string, accountId?: string): string {
  const file = path.join(dataDir, 'nodes.json');
  const token = randomBytes(24).toString('hex');
  const before = read(file);
  const owner = accountId ?? before.find((n) => n.name === name)?.accountId;
  const nodes = before.filter((n) => n.name !== name);
  nodes.push({ name, hash: nodeTokenHash(token), addedAt: Date.now(), ...(owner ? { accountId: owner } : {}) });
  writeFileSync(file, JSON.stringify({ nodes }, null, 2), { mode: 0o600 });
  return token;
}

export function unregisterNode(dataDir: string, name: string): boolean {
  const file = path.join(dataDir, 'nodes.json');
  const before = read(file);
  const nodes = before.filter((n) => n.name !== name);
  writeFileSync(file, JSON.stringify({ nodes }, null, 2), { mode: 0o600 });
  return nodes.length !== before.length;
}

export function registeredNodes(dataDir: string): Registered[] {
  return read(path.join(dataDir, 'nodes.json'));
}
