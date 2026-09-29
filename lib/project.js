// Everything the runner does to a project without AI: clone, worktree, dependencies, preview, tests, screenshots.
// v1 supports Laravel (type "laravel"); other types fail fast in setup.
import fs from 'node:fs';
import path from 'node:path';
import { REPOS, DOCROOT, BROWSERS, ROOT, sh, bash, must, git, tail, host } from './util.js';
import * as Job from './job.js';

const exists = (p) => fs.existsSync(p);
const isLocal = (src) => src.startsWith('/');
const sameFile = (a, b) => exists(a) && exists(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
export const repoDir = (p) => path.join(REPOS, p.name);
export const dbName = (id) => `ai_${id.replace(/[^a-z0-9]+/g, '_')}`.slice(0, 64);
export const previewUrl = (id) => `http://${id}.${host().domain}/`;
// Files whose change means the frontend must be rebuilt.
const FRONTEND = /^(resources\/|vite\.config|package(-lock)?\.json|tsconfig|tailwind\.config|postcss\.config)/;

// Copy without trying to keep ownership (ai can't own files as dev/root).
const copyTree = (src, dst) => must('cp', ['-dR', '--preserve=mode,timestamps', src, dst]);

/**
 * The runner's own clone in repos/<name>, never the user's checkout.
 * For a local source (a checkout on this server) it mirrors that checkout's view of the real remote
 * (its refs/remotes/origin/*), so the base is e.g. GitLab's main as of the owner's last fetch.
 * Its working tree sits on the base branch and holds the dependency cache that job worktrees reuse.
 */
export async function ensureClone(p, say = () => {}) {
  const dir = repoDir(p);
  if (!exists(path.join(dir, '.git'))) {
    if (isLocal(p.source)) {   // the checkout belongs to another user: allow reading it (clone uses the .git path)
      const safe = (await sh('git', ['config', '--global', '--get-all', 'safe.directory'])).out.split('\n');
      for (const d of [p.source, path.join(p.source, '.git')]) {
        if (!safe.includes(d)) await must('git', ['config', '--global', '--add', 'safe.directory', d]);
      }
    }
    say(`cloning ${p.source}`);
    await must('git', ['clone', '--quiet', '--no-checkout', p.source, dir]);
    // A checkout that tracks a real remote: mirror its view of that remote. Otherwise its own branches.
    const tracksRemote = isLocal(p.source)
      && (await sh('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${p.base}`], { cwd: p.source })).code === 0;
    if (tracksRemote) {
      await git(dir, 'config', 'remote.origin.fetch', '+refs/remotes/origin/*:refs/remotes/origin/*');
      for (const ref of (await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')).split('\n').filter(Boolean)) {
        await git(dir, 'update-ref', '-d', ref);
      }
    }
    if (p.remote) await git(dir, 'remote', 'set-url', '--push', 'origin', p.remote);
  }
  say('fetching');
  await git(dir, 'fetch', '--quiet', '--prune', 'origin');
  await git(dir, 'checkout', '--quiet', '--force', '--detach', `origin/${p.base}`);
  await ensureDepsCache(p, dir, say);
  return dir;
}

// vendor/ and node_modules/ for the base commit, copied from deps_from when its lock files match, else installed.
async function ensureDepsCache(p, dir, say) {
  const stampFile = path.join(dir, '.git', 'ai-deps.json');
  const stamp = JSON.parse(exists(stampFile) ? fs.readFileSync(stampFile, 'utf8') : '{}');
  const lockHash = async (f) => (exists(path.join(dir, f)) ? (await git(dir, 'hash-object', f)) : null);
  for (const [lock, depDir, install] of [
    ['composer.lock', 'vendor', 'composer install --no-interaction --no-progress --prefer-dist'],
    ['package-lock.json', 'node_modules', 'npm ci --no-audit --no-fund'],
  ]) {
    const h = await lockHash(lock);
    if (!h || (stamp[lock] === h && exists(path.join(dir, depDir)))) continue;
    fs.rmSync(path.join(dir, depDir), { recursive: true, force: true });
    if (p.deps_from && sameFile(path.join(p.deps_from, lock), path.join(dir, lock)) && exists(path.join(p.deps_from, depDir))) {
      say(`copying ${depDir}/ from ${p.deps_from}`);
      await copyTree(path.join(p.deps_from, depDir), path.join(dir, depDir));
    } else {
      say(`installing ${depDir}/ (${install.split(' ')[0]})`);
      const r = await bash(install, { cwd: dir, heavy: true, timeoutMs: 30 * 60e3 });
      if (r.code) throw new Error(`${install} failed:\n${tail(r.out, 25)}`);
    }
    stamp[lock] = h;
    fs.writeFileSync(stampFile, JSON.stringify(stamp));
  }
}

function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

// .env for the job: built from .env.example (no secrets), never copied from a real .env.
function writeEnv(job, p) {
  const wt = job.worktree;
  let env = exists(path.join(wt, '.env.example')) ? fs.readFileSync(path.join(wt, '.env.example'), 'utf8') : '';
  const vars = {
    APP_ENV: 'local', APP_DEBUG: 'true', APP_URL: previewUrl(job.id).replace(/\/$/, ''),
    DB_CONNECTION: 'mysql', DB_HOST: 'localhost', DB_PORT: '3306', DB_SOCKET: '/run/mysqld/mysqld.sock',
    DB_DATABASE: dbName(job.id), DB_USERNAME: 'ai', DB_PASSWORD: '',
    SESSION_DRIVER: 'file', CACHE_STORE: 'file', QUEUE_CONNECTION: 'sync', MAIL_MAILER: 'log',
    ...(p.env || {}),
  };
  for (const [k, v] of Object.entries(vars)) env = setEnv(env, k, v);
  fs.writeFileSync(path.join(wt, '.env'), env, { mode: 0o640 });
}

// vendor/: hard links (instant, no extra disk), except vendor/composer which Composer rewrites in place.
async function linkVendor(src, dst) {
  await must('cp', ['-al', src, dst]);
  fs.rmSync(path.join(dst, 'composer'), { recursive: true, force: true });
  await copyTree(path.join(src, 'composer'), path.join(dst, 'composer'));
}

// Give the worktree its own dependencies when its lock files differ from the cache (the agent changed them).
async function syncDeps(job, p, say) {
  const wt = job.worktree, repo = repoDir(p);
  if (exists(path.join(wt, 'composer.json'))) {
    if (!exists(path.join(wt, 'vendor'))) {
      if (sameFile(path.join(repo, 'composer.lock'), path.join(wt, 'composer.lock'))) await linkVendor(path.join(repo, 'vendor'), path.join(wt, 'vendor'));
    }
    if (!sameFile(path.join(repo, 'composer.lock'), path.join(wt, 'composer.lock'))) {
      say('composer.lock changed: composer install');
      const r = await bash('composer install --no-interaction --no-progress --prefer-dist', { cwd: wt, heavy: true, timeoutMs: 30 * 60e3 });
      if (r.code) throw new Error(`composer install failed:\n${tail(r.out, 25)}`);
    }
  }
  if (exists(path.join(wt, 'package.json'))) {
    const nm = path.join(wt, 'node_modules');
    const same = sameFile(path.join(repo, 'package-lock.json'), path.join(wt, 'package-lock.json'));
    const linked = exists(nm) && fs.lstatSync(nm).isSymbolicLink();
    if (same && !exists(nm)) fs.symlinkSync(path.join(repo, 'node_modules'), nm);
    if (!same && (linked || !exists(nm))) {
      say('package-lock.json changed: npm ci');
      if (linked) fs.unlinkSync(nm);
      const r = await bash('npm ci --no-audit --no-fund', { cwd: wt, heavy: true, timeoutMs: 30 * 60e3 });
      if (r.code) throw new Error(`npm ci failed:\n${tail(r.out, 25)}`);
    }
  }
}

// Stage "setup": worktree on ai/<job> from the latest base, dependencies, .env with an app key.
export async function setup(job, p, say) {
  if (p.type !== 'laravel') throw new Error(`Project type "${p.type}" isn't supported in v1 (Laravel only).`);
  const repo = await ensureClone(p, say);
  if (!exists(job.worktree)) {
    await git(repo, 'worktree', 'add', '--quiet', '--no-track', '-b', job.branch, job.worktree, `origin/${p.base}`);
  }
  job.base_sha = await git(job.worktree, 'rev-parse', '--short', `origin/${p.base}`);
  job.base = `${p.base}@${job.base_sha}`;
  say(`worktree ${job.worktree} on ${job.branch} from ${job.base}`);
  await syncDeps(job, p, say);
  writeEnv(job, p);
  await must('php', ['artisan', 'key:generate', '--force', '--no-interaction'], { cwd: job.worktree });
  for (const d of ['storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views',
    'storage/framework/testing', 'storage/logs', 'storage/app/public', 'bootstrap/cache']) {
    fs.mkdirSync(path.join(job.worktree, d), { recursive: true });
  }
}

/**
 * Stage "preview": own MariaDB database, fresh migrations + seed, frontend build (reused from a
 * per-base cache when the job didn't touch frontend files), docroot symlink, HTTP check.
 * Problems are returned as notes rather than thrown: the verifier sees them and may fix them.
 */
export async function preview(job, p, say) {
  const wt = job.worktree, notes = [];
  await syncDeps(job, p, say);
  const db = dbName(job.id);
  await must('mysql', ['-e', `CREATE DATABASE IF NOT EXISTS \`${db}\``]);
  await sh('php', ['artisan', 'optimize:clear'], { cwd: wt });
  say(`migrate:fresh --seed on ${db}`);
  const mig = await sh('php', ['artisan', 'migrate:fresh', '--seed', '--force', '--no-interaction'], { cwd: wt, timeoutMs: 10 * 60e3 });
  if (mig.code) notes.push(`migrate:fresh --seed failed (exit ${mig.code}):\n${tail(mig.out, 30)}`);

  const pkg = exists(path.join(wt, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8')) : null;
  if (pkg?.scripts?.build) {
    const changed = (await git(wt, 'diff', '--name-only', `${job.base_sha}...HEAD`)).split('\n').some((f) => FRONTEND.test(f));
    const cache = path.join(REPOS, `${p.name}.build-cache`, job.base_sha);
    const out = path.join(wt, 'public', 'build');
    fs.rmSync(out, { recursive: true, force: true });
    if (!changed && exists(cache)) {
      say('frontend unchanged: reusing cached build');
      await copyTree(cache, out);
    } else {
      say('building frontend (npm run build)');
      const b = await bash('npm run build', { cwd: wt, heavy: true, timeoutMs: 20 * 60e3, env: { NODE_OPTIONS: '--max-old-space-size=1024' } });
      if (b.code) notes.push(`npm run build failed (exit ${b.code}):\n${tail(b.out, 30)}`);
      else if (!changed) { fs.mkdirSync(path.dirname(cache), { recursive: true }); await copyTree(out, cache); }
    }
  }

  const link = path.join(DOCROOT, job.id);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(wt, 'public'), link);
  job.preview_url = previewUrl(job.id);
  const code = (await sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '30', job.preview_url])).out.trim();
  notes.push(`GET / -> HTTP ${code}`);
  if (!/^[23]/.test(code)) {
    const logFile = path.join(wt, 'storage', 'logs', 'laravel.log');
    if (exists(logFile)) notes.push(`Last lines of storage/logs/laravel.log:\n${tail(fs.readFileSync(logFile, 'utf8'), 15)}`);
  }
  return { ok: mig.code === 0 && /^[23]/.test(code), notes };
}

// Stage "test": the project's test commands, one at a time under the heavy lock. Failures are data for the verifier.
export async function runTests(job, p, say) {
  const results = [];
  const logFile = Job.file(job.id, 'tests.log');
  for (const cmd of p.tests || []) {
    say(`test: ${cmd}`);
    const t0 = Date.now();
    const r = await bash(cmd, { cwd: job.worktree, heavy: true, timeoutMs: 25 * 60e3, env: { CI: '1' } });
    const res = { cmd, code: r.code, secs: Math.round((Date.now() - t0) / 1000), tail: tail(r.out, 40) };
    fs.appendFileSync(logFile, `\n===== ${cmd} (exit ${r.code}, ${res.secs}s) =====\n${r.out}\n`);
    say(`  exit ${r.code} in ${res.secs}s`);
    results.push(res);
  }
  return results;
}

// Screenshots (desktop + mobile) of the preview with Playwright, one browser at a time.
export async function snapshots(job, paths, say) {
  const outDir = Job.file(job.id, 'shots');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  say(`screenshots: ${paths.join(' ')}`);
  const r = await sh('node', [path.join(ROOT, 'tools', 'snap.mjs'), job.preview_url.replace(/\/$/, ''), '-', outDir, ...paths],
    { cwd: path.join(ROOT, 'tools'), heavy: true, timeoutMs: 10 * 60e3, env: { PLAYWRIGHT_BROWSERS_PATH: BROWSERS } });
  const shots = JSON.parse(exists(path.join(outDir, 'shots.json')) ? fs.readFileSync(path.join(outDir, 'shots.json'), 'utf8') : '[]');
  if (r.code && !shots.length) say(`  screenshots failed:\n${tail(r.out, 10)}`);
  return shots;
}

// Remove a job's worktree, branch, database and docroot link.
export async function discard(job, p) {
  const repo = repoDir(p);
  fs.rmSync(path.join(DOCROOT, job.id), { force: true });
  await sh('mysql', ['-e', `DROP DATABASE IF EXISTS \`${dbName(job.id)}\``]);
  if (exists(job.worktree)) await sh('git', ['worktree', 'remove', '--force', job.worktree], { cwd: repo });
  await sh('git', ['worktree', 'prune'], { cwd: repo });
  await sh('git', ['branch', '-D', job.branch], { cwd: repo });
}
