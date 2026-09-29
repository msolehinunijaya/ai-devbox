#!/usr/bin/env node
// AI Devbox command line. Use it through ./ai, which runs it as the ai user with the Claude token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, RUN, SETTINGS, CLAUDE_BIN, MAX_JOBS, project, projectNames, readJSON, now, sh } from './lib/util.js';
import * as Job from './lib/job.js';
import * as Project from './lib/project.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? true : undefined; };
const alive = (pid) => { try { return pid && process.kill(pid, 0); } catch { return false; } };
const mins = (s) => (s == null ? '-' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const die = (msg) => { console.error(msg); process.exit(1); };

// A job marked running whose runner process is gone was interrupted (crash, reboot).
function loadJob(id) {
  const job = Job.load(id);
  if (job.state === 'running' && !alive(job.pid)) {
    Object.assign(job, { state: 'interrupted', message: 'The runner stopped unexpectedly. Retry resumes from the current stage.', pid: null });
    Job.save(job);
  }
  return job;
}
const jobs = () => Job.list().map((j) => loadJob(j.id));

function spawnRunner(id) {
  const out = fs.openSync(Job.file(id, 'runner.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'run', id], { detached: true, stdio: ['ignore', out, out], cwd: RUN, env: process.env });
  child.unref();
  return child.pid;
}

function printStatus(job) {
  const icon = { done: '✓', skipped: '–', running: '▶', waiting: '⏸', failed: '✗', cancelled: '■', pending: '·' };
  const dur = (st) => (st.started_at && st.ended_at ? mins(Math.round((Date.parse(st.ended_at) - Date.parse(st.started_at)) / 1000)) : '');
  const u = job.usage;
  console.log(`${job.id}   ${job.state.toUpperCase()}${job.stage ? '  ' + job.stage : ''}   elapsed ${mins(job.elapsed_s)}   ETA ${job.eta_s ? '~' + mins(job.eta_s) : '-'}`);
  console.log(`  prompt:  ${job.prompt}`);
  console.log(`  branch:  ${job.branch}${job.base ? ' from ' + job.base : ''}`);
  if (job.preview_url) console.log(`  preview: ${job.preview_url}`);
  if (u?.five_hour != null) console.log(`  usage:   5h ${Math.round(u.five_hour * 100)}% · 7d ${Math.round((u.seven_day || 0) * 100)}%`);
  console.log('');
  for (const s of Job.STAGES) {
    const st = job.stages[s];
    const extra = st.state === 'waiting' ? 'waiting for you' : st.state === 'skipped' ? st.note || '' : dur(st);
    console.log(`  ${icon[st.state] || '?'} ${s.padEnd(8)} ${extra}`);
    if (s === 'execute') {
      for (const t of job.tasks) {
        const d = t.started_at && t.ended_at ? mins(Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000)) : '';
        console.log(`      ${icon[t.state] || '?'} ${t.id} ${t.title}  (est ${t.estimate_min}m${d ? ', took ' + d : ''})`);
      }
    }
  }
  if (job.message) console.log(`\n  ${job.message}`);
  const logFile = Job.file(job.id, 'log.txt');
  if (fs.existsSync(logFile)) console.log('\n' + fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-8).map((l) => '  ' + l).join('\n'));
}

function printPlan(job) {
  const plan = readJSON(Job.file(job.id, 'plan.json'), null);
  if (!plan) die('No plan yet.');
  const review = readJSON(Job.file(job.id, 'review.json'), null);
  console.log(`Plan for ${job.id}\n\n${plan.summary}\n`);
  for (const t of plan.tasks) {
    console.log(`${t.id}. ${t.title}  (~${t.estimate_min} min)`);
    console.log(`    files:  ${t.files.join(', ')}`);
    for (const s of t.steps) console.log(`    - ${s}`);
    console.log(`    check:  ${t.verify_cmd}\n`);
  }
  console.log(`Screenshots: ${plan.snapshots.map((s) => s.path + (s.login ? ' (login)' : '')).join(', ') || 'none'}`);
  if (plan.risks.length) console.log(`Risks:\n${plan.risks.map((r) => '  - ' + r).join('\n')}`);
  if (review) console.log(`\nReviewer: ${review.approved ? 'approved' : 'corrected the plan'}${review.issues.length ? '\n' + review.issues.map((i) => '  - ' + i).join('\n') : ''}`);
}

// The session to hand over: the most recent Claude session of the job.
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

const commands = {
  async 'add-project'(name) {
    const p = project(name || die('usage: add-project <name> (defined in config/projects.json)'));
    const dir = await Project.ensureClone(p, (t) => console.log(`  ${t}`));
    console.log(`ready: ${dir}`);
  },

  async start(name, ...words) {
    const prompt = words.join(' ').trim();
    if (!name || !prompt) die('usage: start <project> <prompt...>');
    project(name);
    const active = jobs().filter((j) => Job.ACTIVE.includes(j.state));
    if (active.some((j) => j.project === name)) die(`${name} already has a running job (${active.find((j) => j.project === name).id}). One job per project at a time.`);
    if (active.length >= MAX_JOBS) die(`${MAX_JOBS} jobs are already running. (The dashboard will queue jobs; the CLI doesn't.)`);
    const job = Job.create(name, prompt);
    spawnRunner(job.id);
    console.log(`started ${job.id}\n  watch:  ./ai status ${job.id} --watch\n  log:    ./ai log ${job.id}`);
  },

  async run(id) { await (await import('./lib/runner.js')).run(id); },

  async list() {
    const all = jobs();
    if (!all.length) return console.log('No jobs yet. Start one: ./ai start <project> "<prompt>"');
    for (const j of all) console.log(`${j.state.padEnd(17)} ${(j.stage || '').padEnd(8)} ${mins(j.elapsed_s).padStart(8)}  ${j.id}`);
  },

  async status(id) {
    if (!id) return commands.list();
    const watch = args.includes('--watch');
    for (;;) {
      const job = loadJob(id);
      if (watch) process.stdout.write('\x1b[2J\x1b[H');
      printStatus(job);
      if (!watch || !Job.ACTIVE.includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  },

  async log(id) {
    const n = Number(flag('-n') || 40);
    console.log(fs.readFileSync(Job.file(loadJob(id).id, 'log.txt'), 'utf8').trimEnd().split('\n').slice(-n).join('\n'));
  },

  async plan(id) { printPlan(loadJob(id)); },

  async report(id) { console.log(fs.readFileSync(Job.file(loadJob(id).id, 'report.md'), 'utf8')); },

  // Record who approved the (possibly edited) plan.json and continue the job.
  async approve(id) {
    const by = flag('--by') || process.env.SUDO_USER || os.userInfo().username;
    const job = loadJob(id);
    if (job.state !== 'awaiting_approval') die(`${id} is ${job.state}, not waiting for approval.`);
    Object.assign(job, { approved_by: by, approved_at: now(), state: 'queued', message: '' });
    job.stages.approve.state = 'pending';
    Job.save(job);
    Job.log(job, `✔ plan approved by ${by}`);
    spawnRunner(id);
    console.log(`approved; ${id} continues. ./ai status ${id} --watch`);
  },

  async reject(id) {
    const job = loadJob(id);
    if (job.state !== 'awaiting_approval') die(`${id} is ${job.state}, not waiting for approval.`);
    Object.assign(job, { state: 'cancelled', message: 'Plan rejected.', ended_at: now() });
    job.stages.approve.state = 'cancelled';
    Job.log(job, '■ plan rejected');
    Job.save(job);
    console.log(`rejected ${id}. ./ai discard ${id} removes its worktree and database.`);
  },

  // Resume from the stage that stopped. A verify failure gets fresh verify rounds.
  async retry(id) {
    const job = loadJob(id);
    if (!['needs_you', 'failed', 'interrupted', 'cancelled'].includes(job.state)) die(`${id} is ${job.state}; nothing to retry.`);
    for (const s of Job.STAGES) {
      const st = job.stages[s];
      if (['failed', 'running', 'cancelled'].includes(st.state)) {
        st.state = 'pending';
        if (s === 'verify') job.verify_rounds = 0;
      }
    }
    for (const t of job.tasks) if (['failed', 'running'].includes(t.state)) t.state = 'pending';
    Object.assign(job, { state: 'queued', message: '', ended_at: null });
    Job.save(job);
    Job.log(job, '↻ retry');
    spawnRunner(id);
    console.log(`retrying ${id}. ./ai status ${id} --watch`);
  },

  async cancel(id) {
    const job = loadJob(id);
    if (alive(job.pid)) { process.kill(job.pid, 'SIGTERM'); console.log(`cancelling ${id}`); return; }
    if (Job.FINISHED.includes(job.state)) die(`${id} is already ${job.state}.`);
    Object.assign(job, { state: 'cancelled', message: 'Cancelled.', ended_at: now() });
    Job.save(job);
    console.log(`cancelled ${id}`);
  },

  // Remove the worktree, branch, database and preview; keep status and log for history.
  async discard(id) {
    const job = loadJob(id);
    if (alive(job.pid)) die(`${id} is running; cancel it first.`);
    await sh('tmux', ['kill-session', '-t', id]);
    await Project.discard(job, project(job.project));
    for (const f of ['shots', 'logs']) fs.rmSync(Job.file(id, f), { recursive: true, force: true });
    Object.assign(job, { state: 'discarded', preview_url: null, message: 'Worktree, branch, database and preview removed.', ended_at: job.ended_at || now() });
    Job.save(job);
    console.log(`discarded ${id}`);
  },

  // Open the job's latest Claude session in tmux, to continue by hand.
  async takeover(id) {
    const job = loadJob(id);
    if (alive(job.pid)) die(`${id} is running; cancel it first, then take over.`);
    const sid = lastSession(job) || die('This job has no Claude session yet.');
    trustFolder(job.worktree);
    const has = (await sh('tmux', ['has-session', '-t', id])).code === 0;
    if (!has) {
      const r = await sh('tmux', ['new-session', '-d', '-s', id, '-x', '200', '-y', '50', '-c', job.worktree,
        `${CLAUDE_BIN} --resume ${sid} --settings ${SETTINGS}`]);
      if (r.code) die(`tmux failed: ${r.out}`);
    }
    Job.log(job, `⇄ taken over (session ${sid})`);
    const next = Job.FINISHED.includes(job.state) ? '' : ` When done, ./ai retry ${id} continues the pipeline.`;
    console.log(`Session ${sid} is open in tmux session "${id}".\nAttach from the Terminal panel:\n\n  sudo -u ai -i tmux attach -t ${id}\n\nDetach with Ctrl+B then D.${next}`);
  },

  async projects() { for (const n of projectNames()) console.log(n); },
};

const help = `usage: ./ai <command>
  start <project> <prompt...>   start a job        list | status <job> [--watch] | log <job> [-n 80]
  plan <job>                    show the plan      approve <job> [--by name] | reject <job>
  retry <job> | cancel <job> | discard <job> | takeover <job> | report <job>
  add-project <name> | projects`;

if (!commands[cmd]) { console.log(help); process.exit(cmd ? 1 : 0); }
await commands[cmd](...args);
