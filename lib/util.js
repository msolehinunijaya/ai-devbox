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

export function projectNames() { return Object.keys(readJSON(path.join(ROOT, 'config', 'projects.json'))); }

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
export function killChildren(signal = 'SIGTERM') {
  for (const c of children) { try { process.kill(-c.pid, signal); } catch {} }
}

/**
 * Run a command and resolve { code, out } (stdout+stderr, capped); never rejects.
 * heavy: wait for the global lock first, so only one composer/npm/build/test/browser step runs at a time.
 * onLine: called with each stdout line (used to stream Claude's JSON events).
 */
export function sh(cmd, args = [], { cwd, env, input, timeoutMs = 0, heavy = false, onLine } = {}) {
  if (heavy) { args = ['-w', '7200', HEAVY_LOCK, cmd, ...args]; cmd = 'flock'; }
  return new Promise((resolve) => {
    let out = '', partial = '';
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
    child.stderr.on('data', keep);
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

// Like sh(), but throws with the command's output when it fails.
export async function must(cmd, args, opts) {
  const r = await sh(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}):\n${tail(r.out, 25)}`);
  return r.out.trim();
}

export const git = (cwd, ...args) => must('git', args, { cwd });
