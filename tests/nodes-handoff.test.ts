// What a move does at each end (src/server/nodes/handoff.ts): work handed off through origin, and
// each agent's conversation carried from one machine's folders to another's, the folder it was
// worked in rewritten to the one it carries on in.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Carry, claudeProjectDir, handOff, takeOver, unpack, writePiece, type Carrier } from '../src/server/nodes/handoff.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-handoff-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A folder for each end, with a worktree path in it. */
function ends(name: string) {
  const a = path.join(tmp, name, 'a', 'repo', 'wt');
  const b = path.join(tmp, name, 'b', 'repo', 'wt');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return { a, b, envA: { ...process.env, HOME: path.join(tmp, name, 'homeA') }, envB: { ...process.env, HOME: path.join(tmp, name, 'homeB') } };
}

/** Packs on one end, writes it piece by piece on the other and unpacks it there, as NodeRouter.carrySession does. */
async function carry(carrier: Carrier, sessionId: string, from: { cwd: string; env: NodeJS.ProcessEnv }, to: { cwd: string; env: NodeJS.ProcessEnv }) {
  const c = new Carry();
  const pack = await c.pack(carrier, sessionId, from.cwd, from.env);
  for (const { key } of pack.files) {
    for (let offset = 0; ; ) {
      const piece = c.read(sessionId, key, offset);
      writePiece(carrier, sessionId, key, to.cwd, to.env, offset, piece.data);
      offset += Buffer.from(piece.data, 'base64').length;
      if (offset >= piece.size) break;
    }
  }
  await unpack(carrier, sessionId, pack.files.map((f) => f.key), pack.cwd, to.cwd, to.env);
  c.done(sessionId);
  return pack;
}

test("Claude Code's conversation goes to the folder Claude looks in for the new worktree, its path rewritten", async () => {
  const { a, b } = ends('claude');
  const [confA, confB] = [path.join(tmp, 'claude', 'confA'), path.join(tmp, 'claude', 'confB')];
  const from = claudeProjectDir(confA, a);
  mkdirSync(from, { recursive: true });
  // Bigger than one piece, so it goes across in several.
  const lines = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ cwd: a, i, pad: 'x'.repeat(200) })).join('\n');
  writeFileSync(path.join(from, 's-1.jsonl'), `${lines}\n`);
  const pack = await carry('claude', 's-1', { cwd: a, env: { CLAUDE_CONFIG_DIR: confA } }, { cwd: b, env: { CLAUDE_CONFIG_DIR: confB } });
  assert.deepEqual(pack.files.map((f) => f.key), ['s-1.jsonl']);
  const got = readFileSync(path.join(claudeProjectDir(confB, b), 's-1.jsonl'), 'utf8');
  assert.equal(got, `${lines.split(JSON.stringify(a).slice(1, -1)).join(JSON.stringify(b).slice(1, -1))}\n`);
  assert.ok(!got.includes(a));
});

test("Codex's rollout keeps its place under sessions/, in the other end's CODEX_HOME", async () => {
  const { a, b } = ends('codex');
  const [homeA, homeB] = [path.join(tmp, 'codex', 'ca'), path.join(tmp, 'codex', 'cb')];
  const day = path.join(homeA, 'sessions', '2026', '10', '03');
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(day, 'rollout-2026-10-03T10-00-00-0199aaaa-bbbb.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: '0199aaaa-bbbb', cwd: a } })}\n`);
  writeFileSync(path.join(day, 'rollout-2026-10-03T09-00-00-someone-else.jsonl'), 'not this one\n');
  await carry('codex', '0199aaaa-bbbb', { cwd: a, env: { CODEX_HOME: homeA } }, { cwd: b, env: { CODEX_HOME: homeB } });
  const got = path.join(homeB, 'sessions', '2026', '10', '03', 'rollout-2026-10-03T10-00-00-0199aaaa-bbbb.jsonl');
  assert.equal(JSON.parse(readFileSync(got, 'utf8')).payload.cwd, b);
  assert.ok(!existsSync(path.join(homeB, 'sessions', '2026', '10', '03', 'rollout-2026-10-03T09-00-00-someone-else.jsonl')));
});

test("OpenCode's conversation goes through its own export and import, run in each worktree", async () => {
  const { a, b } = ends('opencode');
  const bin = path.join(tmp, 'opencode', 'bin');
  const log = path.join(tmp, 'opencode', 'imported.json');
  mkdirSync(bin, { recursive: true });
  // A stand-in for the opencode CLI: export prints a line and the session; import keeps what it's given, and where.
  writeFileSync(
    path.join(bin, 'opencode'),
    `#!/bin/sh\nif [ "$1" = export ]; then echo "Exporting session: $2"; printf '{"info":{"id":"%s","directory":"%s"},"messages":[]}\\n' "$2" "$(pwd -P)"; else { cat "$2"; echo; pwd -P; } > ${JSON.stringify(log)}; fi\n`,
  );
  chmodSync(path.join(bin, 'opencode'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  await carry('opencode', 'ses_123', { cwd: a, env }, { cwd: b, env });
  const [json, where] = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(JSON.parse(json).info, { id: 'ses_123', directory: b });
  assert.equal(where, b);
});

test('a piece that would land outside its folder is refused', () => {
  const { b } = ends('escape');
  assert.throws(() => writePiece('codex', 's', '../../evil', b, { CODEX_HOME: path.join(tmp, 'escape', 'c') }, 0, ''), /won't write/);
  assert.throws(() => writePiece('claude', '../s', 's.jsonl', b, {}, 0, ''), /won't write/);
});

test('work is handed off through origin and taken over in the other worktree, which must be clean', async () => {
  const origin = path.join(tmp, 'git', 'origin.git');
  mkdirSync(origin, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  const [one, two] = [path.join(tmp, 'git', 'one'), path.join(tmp, 'git', 'two')];
  git(['clone', '-q', origin, one], tmp);
  writeFileSync(path.join(one, 'README.md'), 'hi\n');
  git(['add', '.'], one);
  git(['commit', '-qm', 'init'], one);
  git(['push', '-q', 'origin', 'main'], one);
  git(['clone', '-q', origin, two], tmp);
  const base = git(['rev-parse', 'HEAD'], one);
  const wt = { path: '.agent-office/worktrees/w', branch: 'office/w', base, from: 'main' };
  const here = path.join(one, wt.path);
  git(['worktree', 'add', '-q', '-b', wt.branch, here, base], one);
  writeFileSync(path.join(here, 'work.txt'), 'half done\n');

  const { branch, head } = await handOff(here, 'wip: moving');
  assert.equal(branch, 'office/w');
  assert.equal(git(['rev-parse', `refs/heads/${branch}`], origin), head);

  const there = path.join(two, wt.path);
  await takeOver(two, there, wt, branch);
  assert.equal(readFileSync(path.join(there, 'work.txt'), 'utf8'), 'half done\n');
  assert.equal(git(['rev-parse', 'HEAD'], there), head);

  writeFileSync(path.join(there, 'stray.txt'), 'mine\n');
  await assert.rejects(takeOver(two, there, wt, branch), /has changes of its own/);
});
