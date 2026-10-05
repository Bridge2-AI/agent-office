import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { officeHome } from '../config.js';
import { registerNode, registeredNodes, unregisterNode } from './hub.js';

const HELP = `agent-office nodes — the machines that lend this office their compute

Usage:
  agent-office nodes                 List them
  agent-office nodes add <name>      Add one (or give it a new token) and print the
                                     command to run on that machine
  agent-office nodes remove <name>   Stop it joining again

Options:
  -d, --dir <dir>   The office's folder (default: here if an office runs here, else ~/agent-office)
`;

/** `agent-office nodes`, run on the office's machine, even while the office runs. */
export function nodesCommand(argv: string[]): number {
  let dir = existsSync(path.join(process.cwd(), '.agent-office', 'config.json')) ? process.cwd() : officeHome();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return 0;
    } else if (a === '-d' || a === '--dir') dir = path.resolve(argv[++i] ?? '.');
    else if (a.startsWith('-')) return usage(`unknown option ${a}`);
    else args.push(a);
  }
  const dataDir = path.join(dir, '.agent-office');
  if (!existsSync(dataDir)) {
    console.error(`agent-office nodes: no office has run in ${dir} yet — start it once with \`agent-office\` there`);
    return 1;
  }
  const [cmd = 'list', name] = args;
  switch (cmd) {
    case 'list': {
      const nodes = registeredNodes(dataDir);
      if (!nodes.length) console.log('No nodes yet: agent-office nodes add <name> adds one.');
      for (const n of nodes) console.log(`${n.name}\tadded ${new Date(n.addedAt).toLocaleString()}`);
      return 0;
    }
    case 'add': {
      if (!name || !/^[\w.-]{1,40}$/.test(name)) return usage('add needs a name: letters, digits, . _ or -');
      const token = registerNode(dataDir, name);
      const pin = certPin(dataDir);
      console.log(`Added ${name}. On that machine, with agent-office installed (the same version as here), run:\n`);
      console.log(`  agent-office node --office <this office's address> --name ${name} --token ${token}${pin ? ` --pin ${pin}` : ''}\n`);
      console.log(`<this office's address> is how that machine reaches this one, e.g. ${pin ? 'https' : 'http'}://192.168.1.20:4600 (the office needs --host 0.0.0.0 for that).`);
      if (!pin) console.log('Without --self-signed the office is plain http and the terminals cross the network unencrypted: start it with --self-signed and add the node again for a --pin.');
      console.log('The token is only shown now. Adding the node again gives it a new one.');
      return 0;
    }
    case 'remove':
      if (!name) return usage('remove needs a name');
      if (!unregisterNode(dataDir, name)) {
        console.error(`agent-office nodes: there's no node called ${name}`);
        return 1;
      }
      console.log(`Removed ${name}: its connection closes and it can't join again.`);
      return 0;
    default:
      return usage(`unknown command ${cmd}`);
  }
}

/** The fingerprint of the office's self-signed certificate, for the node to pin. */
function certPin(dataDir: string): string | undefined {
  const file = path.join(dataDir, 'tls-cert.pem');
  try {
    return `sha256:${new X509Certificate(readFileSync(file)).fingerprint256}`;
  } catch {
    return undefined;
  }
}

function usage(why: string): number {
  console.error(`agent-office nodes: ${why}\n\n${HELP}`);
  return 2;
}
