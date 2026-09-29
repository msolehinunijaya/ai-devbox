// Paths, config, JSON files and child processes shared by the runner and the CLI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUN = path.join(ROOT, 'run');
export const JOBS = path.join(RUN, 'jobs');
export const WORKTREES = path.join(RUN, 'worktrees');
export const DOCROOT = path.join(RUN, 'docroot');
export const REPOS = path.join(ROOT, 'repos');
export const HEAVY_LOCK = path.join(RUN, 'heavy.lock');
export const CLAUDE_BIN = '/opt/ai-devbox/bin/claude';
export const SETTINGS = path.join(ROOT, 'config', 'claude-settings.json');
export const BROWSERS = path.join(ROOT, 'tools', 'ms-playwright');
export const MAX_JOBS = 2;
// A second job only starts while at least this much memory is available (MemAvailable, MB).
export const MIN_START_MB = Number(process.env.AI_DEVBOX_MIN_START_MB || 400);
export const memAvailableMb = () => Math.round(Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)[1]) / 1024);
export const MODELS = { plan: 'opus', review: 'opus', execute: 'sonnet', verify: 'opus' };

export const now = () => new Date().toISOString();

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

// Write via rename so readers (CLI, dashboard) never see a half-written file.
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function project(name) {
  const all = readJSON(path.join(ROOT, 'config', 'projects.json'));
  if (!all[name]) throw new Error(`Unknown project "${name}". Known: ${Object.keys(all).join(', ')}`);
  return { name, ...all[name] };
}

// Projects offered for new jobs ("enabled": false hides one without forgetting its settings).
export function projectNames() {
  return Object.entries(readJSON(path.join(ROOT, 'config', 'projects.json'))).filter(([, p]) => p.enabled !== false).map(([n]) => n);
}

// Written by setup.sh: { "ts_ip": "100.x.y.z", "domain": "100-x-y-z.sslip.io" }
export const host = () => readJSON(path.join(RUN, 'host.json'));

export function render(name, vars) {
  const text = fs.readFileSync(path.join(ROOT, 'prompts', `${name}.md`), 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const schema = (name) => readJSON(path.join(ROOT, 'prompts', `${name}.schema.json`));

export const tail = (text, lines = 40) => String(text).trimEnd().split('\n').slice(-lines).join('\n');

// Children are started in their own process group so cancel can stop a whole tree (npm -> node -> ...).
const children = new Set();
const LOCKED = '[heavy lock acquired]';
let lockWaitHook = null;
// fn(ms, what) is called when a heavy step got the lock, so the runner can log long waits.
export const onLockWait = (fn) => { lockWaitHook = fn; };
export function killChildren(signal = 'SIGTERM') {
  for (const c of children) { try { process.kill(-c.pid, signal); } catch {} }
}

/**
 * Run a command and resolve { code, out } (stdout+stderr, capped); never rejects.
 * heavy: wait for the global lock first, so only one composer/npm/build/test/browser step runs at a time.
 * onLine: called with each stdout line (used to stream Claude's JSON events).
 */
export function sh(cmd, args = [], { cwd, env, input, timeoutMs = 0, heavy = false, onLine } = {}) {
  const what = [cmd, ...args].join(' ').slice(0, 80);
  if (heavy) {
    // Low CPU/disk priority keeps the live sites responsive on the single core; the marker measures the lock wait.
    args = ['-w', '7200', HEAVY_LOCK, 'nice', '-n', '10', 'ionice', '-c2', '-n7',
      'bash', '-c', `echo "${LOCKED}" >&2; exec "$0" "$@"`, cmd, ...args];
    cmd = 'flock';
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '', partial = '', waited = !heavy;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const keep = (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); };
    child.stdout.on('data', (d) => {
      keep(d);
      if (!onLine) return;
      const lines = (partial + d).split('\n');
      partial = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.on('data', (d) => {
      if (!waited && String(d).includes(LOCKED)) { waited = true; lockWaitHook?.(Date.now() - t0, what); d = String(d).replace(`${LOCKED}\n`, ''); }
      keep(d);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const timer = timeoutMs && setTimeout(() => {
      out += `\n[stopped after ${Math.round(timeoutMs / 60000)} min]\n`;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }, timeoutMs);
    const done = (code) => { clearTimeout(timer); children.delete(child); resolve({ code, out }); };
    child.on('error', (e) => { out += e.message; done(127); });
    child.on('close', (code, signal) => {
      if (onLine && partial.trim()) onLine(partial);
      done(code ?? (signal ? 128 : 1));
    });
  });
}

export const bash = (script, opts) => sh('bash', ['-c', script], opts);

// Stop processes still running inside a directory (e.g. a dev server an agent started in the
// background, which escapes our process groups). Returns how many were signalled.
export function killStrays(dir) {
  let n = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === dir || cwd.startsWith(dir + '/')) { process.kill(Number(pid), 'SIGTERM'); n++; }
    } catch {}   // gone, or not ours
  }
  return n;
}

// Like sh(), but throws with the command's output when it fails.
export async function must(cmd, args, opts) {
  const r = await sh(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}):\n${tail(r.out, 25)}`);
  return r.out.trim();
}

export const git = (cwd, ...args) => must('git', args, { cwd });
