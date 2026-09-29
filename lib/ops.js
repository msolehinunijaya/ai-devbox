// Job operations shared by the CLI and the dashboard, plus the queue that starts jobs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, RUN, SETTINGS, CLAUDE_BIN, MAX_JOBS, MIN_START_MB, memAvailableMb, project, readJSON, writeJSON, now, sh } from './util.js';
import * as Job from './job.js';
import * as Project from './project.js';

export const alive = (pid) => { try { return !!pid && process.kill(pid, 0); } catch { return false; } };
const claimFile = (id) => Job.file(id, '.claim');
const ACTIVE_STATES = ['queued', 'running', 'awaiting_approval'];

// A job marked running whose runner is gone was interrupted (crash, reboot, earlyoom).
export function refresh(job) {
  if (job.state === 'running' && !alive(job.pid)) {
    Object.assign(job, { state: 'interrupted', message: 'The runner stopped unexpectedly. Retry resumes from the current stage.', pid: null });
    Job.save(job);
  }
  if (!job.tokens && !['queued', 'running'].includes(job.state)) {   // jobs from before token tracking
    const t = Job.tokensFromLogs(job);
    if (t) { job.tokens = t; Job.save(job); }
  }
  Job.computeEta(job);   // live elapsed/ETA/progress for readers, without writing
  return job;
}
export const get = (id) => refresh(Job.load(id));
export const jobs = () => Job.list().map(refresh);

function spawnRunner(id) {
  const out = fs.openSync(Job.file(id, 'runner.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'run', id], { detached: true, stdio: ['ignore', out, out], cwd: RUN, env: process.env });
  child.unref();
}

// Only one process at a time decides what starts (CLI, dashboard, or a runner that just finished).
function withQueueLock(fn) {
  const lock = path.join(RUN, '.queue-lock');
  try { fs.mkdirSync(lock); }
  catch {
    if (Date.now() - fs.statSync(lock).mtimeMs < 30e3) return;   // someone else is ticking
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock); } catch { return; }
  }
  try { fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Start queued jobs, oldest first, while fewer than MAX_JOBS run and never two on one project.
 * A job counts as busy from the moment it's claimed, so a runner that hasn't written its pid yet
 * isn't started twice.
 */
export function tick() {
  withQueueLock(() => {
    const all = jobs();
    // A claim without a live runner after a minute means the runner never started: free the slot.
    for (const j of all) {
      const c = claimFile(j.id);
      if (j.state === 'queued' && fs.existsSync(c) && !alive(j.pid) && Date.now() - fs.statSync(c).mtimeMs > 60e3) fs.rmSync(c, { force: true });
    }
    const busy = all.filter((j) => j.state === 'running' || (j.state === 'queued' && fs.existsSync(claimFile(j.id))));
    for (const j of all.filter((x) => x.state === 'queued' && !fs.existsSync(claimFile(x.id)))) {
      if (busy.length >= MAX_JOBS || busy.some((b) => b.project === j.project)) continue;
      const free = memAvailableMb();
      if (busy.length && free < MIN_START_MB) {   // the first job always starts; a second waits for memory
        const msg = `Waiting for memory: ${free} MB free, a second job needs ${MIN_START_MB} MB.`;
        if (j.message !== msg) { j.message = msg; Job.save(j); }
        continue;
      }
      if (j.message.startsWith('Waiting for memory')) { j.message = ''; Job.save(j); }
      try { fs.writeFileSync(claimFile(j.id), String(process.pid), { flag: 'wx' }); } catch { continue; }
      spawnRunner(j.id);
      busy.push(j);
    }
  });
}

// Put a job (back) in the queue and let the scheduler start it when there's room.
function enqueue(job, message = '') {
  fs.rmSync(claimFile(job.id), { force: true });
  Object.assign(job, { state: 'queued', message, ended_at: null });
  Job.save(job);
  tick();
  return Job.load(job.id);
}

export function queuePosition(job) {
  if (job.state !== 'queued' || fs.existsSync(claimFile(job.id))) return null;   // claimed = starting now
  return jobs().filter((j) => j.state === 'queued' && j.created_at <= job.created_at).length;
}

export function start(projectName, prompt) {
  prompt = String(prompt || '').trim();
  if (!prompt) throw new Error('The prompt is empty.');
  if (project(projectName).enabled === false) throw new Error(`Project "${projectName}" is disabled in config/projects.json.`);
  return enqueue(Job.create(projectName, prompt));
}

export function savePlan(id, plan) {
  const job = get(id);
  if (job.state !== 'awaiting_approval') throw new Error(`${id} is ${job.state}; the plan can only be edited while it waits for approval.`);
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('The plan needs a non-empty "tasks" list.');
  for (const t of plan.tasks) {
    for (const k of ['id', 'title', 'verify_cmd']) if (typeof t[k] !== 'string' || !t[k]) throw new Error(`Every task needs a "${k}".`);
    t.files ||= []; t.steps ||= []; t.estimate_min = Number(t.estimate_min) || 10;
  }
  plan.summary ||= ''; plan.snapshots ||= []; plan.risks ||= [];
  writeJSON(Job.file(id, 'plan.json'), plan);
  Job.log(job, '✎ plan edited');
}

export function approve(id, by) {
  const job = get(id);
  if (job.state !== 'awaiting_approval') throw new Error(`${id} is ${job.state}, not waiting for approval.`);
  Object.assign(job, { approved_by: by, approved_at: now() });
  job.stages.approve.state = 'pending';
  Job.log(job, `✔ plan approved by ${by}`);
  return enqueue(job);
}

export function reject(id) {
  const job = get(id);
  if (job.state !== 'awaiting_approval') throw new Error(`${id} is ${job.state}, not waiting for approval.`);
  Object.assign(job, { state: 'cancelled', message: 'Plan rejected.', ended_at: now() });
  job.stages.approve.state = 'cancelled';
  Job.log(job, '■ plan rejected');
  Job.save(job);
  tick();
  return job;
}

// Resume from the stage that stopped, or rerun everything from `from` (e.g. "preview"). Verify gets fresh rounds.
export function retry(id, from) {
  const job = get(id);
  if (!['needs_you', 'failed', 'interrupted', 'cancelled', ...(from ? ['done'] : [])].includes(job.state)) throw new Error(`${id} is ${job.state}; nothing to retry.`);
  if (from && !Job.STAGES.includes(from)) throw new Error(`Unknown stage "${from}". Stages: ${Job.STAGES.join(', ')}`);
  const fromIdx = from ? Job.STAGES.indexOf(from) : Infinity;
  for (const [i, s] of Job.STAGES.entries()) {
    const st = job.stages[s];
    if (i >= fromIdx || ['failed', 'running', 'cancelled'].includes(st.state)) {
      if (st.state !== 'skipped' || i >= fromIdx) st.state = 'pending';
      if (s === 'verify') job.verify_rounds = 0;
      if (s === 'execute' && i >= fromIdx) for (const t of job.tasks) t.state = 'pending';
    }
  }
  for (const t of job.tasks) if (['failed', 'running'].includes(t.state)) t.state = 'pending';
  Job.log(job, '↻ retry');
  return enqueue(job);
}

export function cancel(id) {
  const job = get(id);
  if (alive(job.pid)) { process.kill(job.pid, 'SIGTERM'); return job; }   // the runner records the cancel
  if (Job.FINISHED.includes(job.state)) throw new Error(`${id} is already ${job.state}.`);
  fs.rmSync(claimFile(id), { force: true });
  Object.assign(job, { state: 'cancelled', message: 'Cancelled.', ended_at: now() });
  Job.save(job);
  return job;
}

// Remove the worktree, branch, database and preview; keep status and log for history.
export async function discard(id) {
  const job = get(id);
  if (alive(job.pid)) throw new Error(`${id} is running; cancel it first.`);
  await sh('tmux', ['kill-session', '-t', id]);
  await Project.discard(job, project(job.project));
  for (const f of ['shots', 'logs']) fs.rmSync(Job.file(id, f), { recursive: true, force: true });
  Object.assign(job, { state: 'discarded', preview_url: null, message: 'Worktree, branch, database and preview removed.', ended_at: job.ended_at || now() });
  Job.save(job);
  tick();
  return job;
}

// Free a finished job's preview, database and worktree but keep its branch, report and screenshots.
export async function archive(id) {
  const job = get(id);
  if (alive(job.pid) || ACTIVE_STATES.includes(job.state)) throw new Error(`${id} is ${job.state}; only finished jobs can be archived.`);
  if (job.state === 'discarded') throw new Error(`${id} is already discarded.`);
  await sh('tmux', ['kill-session', '-t', id]);
  await Project.archive(job, project(job.project));
  Object.assign(job, { archived_at: now(), preview_url: null });
  Job.log(job, `▣ archived: preview, database and worktree removed; branch ${job.branch} kept`);
  Job.save(job);
  return job;
}

export const KEEP_DAYS = Number(process.env.AI_DEVBOX_KEEP_DAYS || 7);

// Archive done/failed/cancelled jobs that ended more than KEEP_DAYS ago. Jobs that need you are left alone.
export async function cleanup({ days = KEEP_DAYS, dryRun = false } = {}) {
  const cutoff = Date.now() - days * 86400e3;
  const due = jobs().filter((j) => ['done', 'failed', 'cancelled'].includes(j.state) && !j.archived_at
    && Date.parse(j.ended_at || j.updated_at) < cutoff);
  if (!dryRun) for (const j of due) await archive(j.id);
  return due.map((j) => j.id);
}

// The most recent Claude session of the job.
function lastSession(job) {
  const t = [...job.tasks].reverse().find((x) => x.session_id && x.state !== 'pending');
  return (job.verify_rounds && job.stages.verify.session_id) || t?.session_id || job.stages.review.session_id || job.stages.plan.session_id;
}

// Interactive Claude refuses to start in an untrusted folder, so trust the job's worktree first.
function trustFolder(dir) {
  const f = path.join(os.homedir(), '.claude.json');
  const j = readJSON(f, {});
  j.projects = j.projects || {};
  j.projects[dir] = { ...(j.projects[dir] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
}

// Open the job's latest Claude session in tmux, to continue by hand from a terminal.
export async function takeover(id) {
  const job = get(id);
  if (alive(job.pid)) throw new Error(`${id} is running; cancel it first, then take over.`);
  const sid = lastSession(job);
  if (!sid) throw new Error('This job has no Claude session yet.');
  if (!fs.existsSync(job.worktree)) throw new Error('The worktree was discarded.');
  trustFolder(job.worktree);
  if ((await sh('tmux', ['has-session', '-t', id])).code !== 0) {
    const r = await sh('tmux', ['new-session', '-d', '-s', id, '-x', '200', '-y', '50', '-c', job.worktree,
      `${CLAUDE_BIN} --resume ${sid} --settings ${SETTINGS}`]);
    if (r.code) throw new Error(`tmux failed: ${r.out}`);
  }
  Job.log(job, `⇄ taken over (session ${sid})`);
  return { session_id: sid, attach: `sudo -u ai -i tmux attach -t ${id}`, can_retry: !Job.FINISHED.includes(job.state) };
}
