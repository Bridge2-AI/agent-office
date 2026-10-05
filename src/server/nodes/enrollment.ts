import { X509Certificate } from 'node:crypto';
import type { Config } from '../config.js';
import { shq } from '../workers/process.js';

export const memberNodeName = (accountId: string) => `member-${accountId}`;

export function connectionCommand(cfg: Config, origin: string, name: string, token: string, maxWorkers: number): string {
  const office = new URL(origin);
  if (!['http:', 'https:'].includes(office.protocol)) throw new Error('Expected an HTTP office address');
  const address = shq(office.origin);
  const pin = cfg.tls && !cfg.trustProxy && office.protocol === 'https:' ? ` --pin sha256:${new X509Certificate(cfg.tls.cert).fingerprint256}` : '';
  return `agent-office node --office ${address} --name ${name} --token ${token} --max-workers ${maxWorkers}${pin}`;
}
