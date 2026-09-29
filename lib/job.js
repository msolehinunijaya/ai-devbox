// Job state: one run/jobs/<id>/status.json per job, plus its log, plan, report and screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { JOBS, WORKTREES, readJSON, writeJSON, now } from './util.js';

export const STAGES = ['setup', 'plan', 'review', 'approve', 'execute', 'preview', 'test', 'verify', 'publish'];
// Seconds a stage usually takes; ETA uses these until real timings replace them.
const STAGE_EST = { setup: 90, plan: 240, review: 150, approve: 0, execute: 900, preview: 240, test: 360, verify: 420, publish: 15 };
export const ACTIVE = ['queued', 'running'];
export const FINISHED = ['done', 'failed', 'cancelled', 'discarded'];

export const dir = (id) => path.join(JOBS, id);
export const file = (id, name) => path.join(JOBS, id, name);

export function load(id) {
  const job = readJSON(file(id, 'status.json'), null);
  if (!job) throw new Error(`No job "${id}"`);
  return job;
}

export function save(job) {
  job.updated_at = now();
  computeEta(job);
  writeJSON(file(job.id, 'status.json'), job);
}

export function list() {
  if (!fs.existsSync(JOBS)) return [];
  return fs.readdirSync(JOBS)
    .map((id) => readJSON(file(id, 'status.json'), null))
    .filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function log(job, text) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${text.replace(/\s+$/, '')}\n`;
  fs.appendFileSync(file(job.id, 'log.txt'), line);
}

// <project>-<3-5 words of the prompt>-<MMDD-HHMM>: readable, and a valid DNS label for the preview URL.
function makeId(projectName, prompt) {
  const words = prompt.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !['the', 'a', 'an', 'to', 'of', 'and', 'in', 'on', 'for', 'with'].includes(w));
  let slug = '';
  for (const w of words) { if ((slug + '-' + w).length > 28) break; slug = slug ? `${slug}-${w}` : w; }
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const base = `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${slug || 'job'}-${stamp}`;
  let id = base;
  for (let n = 2; fs.existsSync(dir(id)); n++) id = `${base}-${n}`;
  return id;
}

export function create(projectName, prompt) {
  const id = makeId(projectName, prompt);
  fs.mkdirSync(path.join(dir(id), 'logs'), { recursive: true });
  const job = {
    id, project: projectName, prompt, state: 'queued', stage: null, message: '',
    created_at: now(), updated_at: now(), ended_at: null,
    branch: `ai/${id}`, worktree: path.join(WORKTREES, id), base: null, base_sha: null,
    preview_url: null, pid: null, approved_by: null, verify_rounds: 0, verdict: null, usage: null,
    stages: Object.fromEntries(STAGES.map((s) => [s, { state: 'pending' }])),
    tasks: [], eta_s: null, elapsed_s: 0,
  };
  save(job);
  return job;
}

const secs = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;

// ETA = pending task estimates x (actual/estimated ratio of finished tasks) + typical time of remaining stages.
export function computeEta(job) {
  const t = now();
  const done = job.tasks.filter((x) => x.state === 'done' && x.started_at && x.ended_at);
  const est = done.reduce((s, x) => s + x.estimate_min * 60, 0);
  const act = done.reduce((s, x) => s + secs(x.started_at, x.ended_at), 0);
  const ratio = est ? Math.min(3, Math.max(0.1, act / est)) : 1;
  const left = (estimate, started) => (started ? Math.max(estimate * 0.1, estimate - secs(started, t)) : estimate);
  let rem = 0;
  for (const s of STAGES) {
    const st = job.stages[s];
    if (st.state === 'done' || st.state === 'skipped') continue;
    if (s === 'execute' && job.tasks.length) {
      for (const tk of job.tasks) {
        if (tk.state !== 'done') rem += left(tk.estimate_min * 60 * ratio, tk.state === 'running' && tk.started_at);
      }
    } else {
      rem += left(STAGE_EST[s], st.state === 'running' && st.started_at);
    }
  }
  job.eta_s = FINISHED.includes(job.state) || job.state === 'needs_you' ? 0 : Math.round(rem);
  // Progress = work time spent / (spent + ETA); waiting for approval doesn't count as work.
  let spent = 0;
  for (const s of STAGES) {
    const st = job.stages[s];
    if (s !== 'approve' && st.started_at && ['done', 'running', 'failed'].includes(st.state)) spent += secs(st.started_at, st.ended_at || t);
  }
  job.progress = job.state === 'done' ? 1 : spent + rem ? Math.round((spent / (spent + rem)) * 1000) / 1000 : 0;
  job.elapsed_s = Math.round(secs(job.created_at, job.ended_at || t));
}
