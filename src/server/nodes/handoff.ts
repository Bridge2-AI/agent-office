import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// What moving a worker from one machine to another does on each end (see NodeRouter.move): its
// work committed and pushed on the one, its worktree brought to that commit on the other, and its
// conversation (Claude Code's, Codex's or OpenCode's) carried across in pieces, so it carries on
// where it was.

const execFileP = promisify(execFile);

/** How much of a conversation goes in one message. */
export const CHUNK = 512 * 1024;
const SESSION_ID = /^[\w-]{1,100}$/;

/** The worktree a worker works in, as each end says it: relative to the project, with what it branched from. */
export interface WorktreeAt {
  path: string;
  branch: string;
  base: string;
  from?: string;
}

export async function git(args: string[], cwd: string, timeout = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(stderr.split('\n').filter(Boolean).pop() || (err as Error).message);
  }
}

/**
 * A worker's worktree in `dir`, made like the office made its own: from its base commit, else the
 * branch it targets, else its branch as it is.
 */
export async function makeWorktree(dir: string, cwd: string, wt: WorktreeAt) {
  if (existsSync(cwd)) return;
  await git(['fetch', '--quiet', '--no-tags', 'origin', ...(wt.from ? [wt.from] : [])], dir).catch(() => {});
  const tries = [['worktree', 'add', '-b', wt.branch, cwd, wt.base], ...(wt.from ? [['worktree', 'add', '-b', wt.branch, cwd, `origin/${wt.from}`]] : []), ['worktree', 'add', cwd, wt.branch]];
  let last: unknown;
  for (const args of tries) {
    try {
      await git(args, dir);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`couldn't make its worktree here: ${(last as Error).message}`);
}

/** Everything in the worktree committed and pushed, so another machine can carry on from it. Says which branch, at which commit. */
export async function handOff(cwd: string, message: string): Promise<{ branch: string; head: string }> {
  const branch = await git(['branch', '--show-current'], cwd);
  if (!branch) throw new Error("its worktree isn't on a branch");
  await git(['add', '-A'], cwd);
  if (await git(['status', '--porcelain'], cwd)) {
    // Someone with no git name set up still gets their work moved.
    const named = await git(['config', 'user.email'], cwd).catch(() => '');
    const as = named ? [] : ['-c', 'user.name=Agent Office', '-c', 'user.email=agent-office@users.noreply.github.com'];
    await git([...as, 'commit', '--quiet', '--no-verify', '-m', message], cwd);
  }
  await git(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`], cwd, 120_000);
  return { branch, head: await git(['rev-parse', 'HEAD'], cwd) };
}

/** The worktree in `dir`, made if need be, brought to what was handed off: `branch` as origin has it. */
export async function takeOver(dir: string, cwd: string, wt: WorktreeAt, branch: string) {
  await makeWorktree(dir, cwd, wt);
  if (await git(['status', '--porcelain'], cwd)) throw new Error(`its worktree here (${cwd}) has changes of its own`);
  await git(['fetch', '--quiet', '--no-tags', 'origin', branch], cwd);
  await git(['checkout', '--quiet', '-B', branch, 'FETCH_HEAD'], cwd);
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
}

/** Where Claude Code keeps the conversations it has in `cwd`: its path, with a dash for every character that isn't a letter or digit. */
export function claudeProjectDir(configDir: string, cwd: string): string {
  return path.join(configDir, 'projects', real(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** How an agent's conversation is carried: as Claude Code's transcript, Codex's rollout, or OpenCode's export. */
export type Carrier = 'claude' | 'codex' | 'opencode';
/** Which way each provider's conversation goes; one not here starts afresh after a move. */
export const CARRIERS: Partial<Record<string, Carrier>> = { claude: 'claude', custom: 'claude', codex: 'codex', opencode: 'opencode' };

/** What a machine has packed up of a conversation to send: its files, by a key the other end puts each one by, and where it worked. */
export interface Pack {
  cwd: string;
  files: { key: string; size: number }[];
}

/** A conversation's transcript, in whichever of Claude Code's `configDirs` has it. */
export function findSession(configDirs: string[], sessionId: string): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  for (const dir of configDirs) {
    let projects: string[];
    try {
      projects = readdirSync(path.join(dir, 'projects'));
    } catch {
      continue;
    }
    for (const p of projects) {
      const file = path.join(dir, 'projects', p, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/** Codex's rollout of a session: sessions/<year>/<month>/<day>/rollout-<when>-<id>.jsonl. */
function findRollout(home: string, sessionId: string): string | undefined {
  let found: string[];
  try {
    found = readdirSync(path.join(home, 'sessions'), { recursive: true }) as string[];
  } catch {
    return undefined;
  }
  const hit = found.find((f) => f.endsWith(`-${sessionId}.jsonl`));
  return hit && path.join(home, 'sessions', hit);
}

/**
 * One machine's end of carrying conversations. The sending end packs one up (pack), the office
 * reads it a piece at a time (read) and has the other end write each piece (writePiece) and then
 * open it there (unpack); the sending end lets go of it at the end (done).
 */
export class Carry {
  private packed = new Map<string, { files: Map<string, string>; tmp?: string }>();

  async pack(carrier: Carrier, sessionId: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Pack> {
    if (!SESSION_ID.test(sessionId)) throw new Error('not a session id');
    const files = new Map<string, string>();
    let tmp: string | undefined;
    if (carrier === 'claude') {
      const f = findSession([claudeConfigDir(env)], sessionId);
      if (f) files.set(`${sessionId}.jsonl`, f);
    } else if (carrier === 'codex') {
      const home = codexHome(env);
      const f = findRollout(home, sessionId);
      if (f) files.set(path.relative(home, f), f);
    } else {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-office-export-'));
      const out = await run('opencode', ['export', sessionId], cwd, env);
      const json = out.slice(out.indexOf('{'));
      JSON.parse(json); // it printed the session, not an error
      writeFileSync(path.join(tmp, 'export.json'), json, { mode: 0o600 });
      files.set('export.json', path.join(tmp, 'export.json'));
    }
    this.done(sessionId);
    this.packed.set(sessionId, { files, tmp });
    return { cwd: real(cwd), files: [...files].map(([key, f]) => ({ key, size: statSync(f).size })) };
  }

  read(sessionId: string, key: string, offset: number): { data: string; size: number } {
    const f = this.packed.get(sessionId)?.files.get(key);
    if (!f) throw new Error(`nothing packed as ${key}`);
    return readChunk(f, offset);
  }

  done(sessionId: string) {
    const p = this.packed.get(sessionId);
    this.packed.delete(sessionId);
    if (p?.tmp) rmSync(p.tmp, { recursive: true, force: true });
  }
}

/** Where a piece of a conversation goes on the receiving end. */
function target(carrier: Carrier, sessionId: string, key: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (!SESSION_ID.test(sessionId) || path.isAbsolute(key) || key.split(/[\\/]/).includes('..')) throw new Error(`won't write ${key}`);
  if (carrier === 'claude') return path.join(claudeProjectDir(claudeConfigDir(env), cwd), key);
  if (carrier === 'codex') return path.join(codexHome(env), key);
  return path.join(os.tmpdir(), `agent-office-import-${sessionId}`, key);
}

/** A piece of a conversation, written where it goes: the first piece of a file starts it afresh. */
export function writePiece(carrier: Carrier, sessionId: string, key: string, cwd: string, env: NodeJS.ProcessEnv, offset: number, data: string) {
  const file = target(carrier, sessionId, key, cwd, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const buf = Buffer.from(data, 'base64');
  if (offset === 0) writeFileSync(file, buf, { mode: 0o600 });
  else appendFileSync(file, buf);
}

/**
 * A conversation that has all arrived, made this machine's: the folder it was worked in there is
 * this one here, all through it, and OpenCode's is imported into its own store.
 */
export async function unpack(carrier: Carrier, sessionId: string, keys: string[], fromCwd: string, cwd: string, env: NodeJS.ProcessEnv) {
  const here = real(cwd);
  for (const key of keys) {
    const file = target(carrier, sessionId, key, cwd, env);
    if (fromCwd !== here) {
      const [a, b] = [JSON.stringify(fromCwd).slice(1, -1), JSON.stringify(here).slice(1, -1)];
      writeFileSync(file, readFileSync(file, 'utf8').split(a).join(b), { mode: 0o600 });
    }
    if (carrier === 'opencode') await run('opencode', ['import', file], cwd, env);
  }
  if (carrier === 'opencode') rmSync(path.dirname(target(carrier, sessionId, 'x', cwd, env)), { recursive: true, force: true });
}

async function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, env, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`${cmd} ${args[0]}: ${stderr.split('\n').filter(Boolean).pop() || (err as Error).message}`);
  }
}

/** A piece of a file (base64) from `offset`, and how long the whole of it is. */
export function readChunk(file: string, offset: number): { data: string; size: number } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(CHUNK, size - offset)));
    const n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0;
    return { data: buf.subarray(0, n).toString('base64'), size };
  } finally {
    closeSync(fd);
  }
}
