#!/usr/bin/env node
// AI Devbox command line. Use it through ./ai, which runs it as the ai user with the Claude token.
import fs from 'node:fs';
import os from 'node:os';
import { project, projectNames, readJSON } from './lib/util.js';
import * as Job from './lib/job.js';
import * as Ops from './lib/ops.js';
import * as Project from './lib/project.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? true : undefined; };
const mins = (s) => (s == null ? '-' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const die = (msg) => { console.error(msg); process.exit(1); };
const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const tokenLine = (t) => `${num(Job.tokenCount(t))} (output ${num(t.output)}, input ${num(t.input)}, cache read ${num(t.cache_read)}, cache write ${num(t.cache_write)}) · ≈$${t.cost_usd.toFixed(2)} at API prices`;

function printStatus(job) {
  const icon = { done: '✓', skipped: '–', running: '▶', waiting: '⏸', failed: '✗', cancelled: '■', pending: '·' };
  const dur = (st) => (st.started_at && st.ended_at ? mins(Math.round((Date.parse(st.ended_at) - Date.parse(st.started_at)) / 1000)) : '');
  const u = job.usage;
  const pos = Ops.queuePosition(job);
  console.log(`${job.id}   ${job.state.toUpperCase()}${pos ? ' #' + pos : ''}${job.stage ? '  ' + job.stage : ''}   elapsed ${mins(job.elapsed_s)}   ETA ${job.eta_s ? '~' + mins(job.eta_s) : '-'}   ${Math.round((job.progress || 0) * 100)}%`);
  console.log(`  prompt:  ${job.prompt}`);
  console.log(`  branch:  ${job.branch}${job.base ? ' from ' + job.base : ''}`);
  if (job.preview_url) console.log(`  preview: ${job.preview_url}`);
  if (u?.five_hour != null) console.log(`  usage:   5h ${Math.round(u.five_hour * 100)}% · 7d ${Math.round((u.seven_day || 0) * 100)}%`);
  if (job.tokens) console.log(`  tokens:  ${tokenLine(job.tokens.total)}`);
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

const commands = {
  async 'add-project'(name) {
    const p = project(name || die('usage: add-project <name> (defined in config/projects.json)'));
    const dir = await Project.ensureClone(p, (t) => console.log(`  ${t}`));
    console.log(`ready: ${dir}`);
  },

  async start(name, ...words) {
    if (!name || !words.length) die('usage: start <project> <prompt...>');
    const job = Ops.start(name, words.join(' '));
    const pos = Ops.queuePosition(job);
    console.log(`${pos ? `queued (#${pos})` : 'started'} ${job.id}\n  watch:  ./ai status ${job.id} --watch\n  log:    ./ai log ${job.id}`);
  },

  async run(id) { await (await import('./lib/runner.js')).run(id); },

  async list() {
    const all = Ops.jobs();
    if (!all.length) return console.log('No jobs yet. Start one: ./ai start <project> "<prompt>"');
    for (const j of all) console.log(`${j.state.padEnd(17)} ${(j.stage || '').padEnd(8)} ${mins(j.elapsed_s).padStart(8)}  ${j.id}`);
  },

  async status(id) {
    if (!id) return commands.list();
    const watch = args.includes('--watch');
    for (;;) {
      const job = Ops.get(id);
      if (watch) process.stdout.write('\x1b[2J\x1b[H');
      printStatus(job);
      if (!watch || !Job.ACTIVE.includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  },

  async log(id) {
    const n = Number(flag('-n') || 40);
    console.log(fs.readFileSync(Job.file(Ops.get(id).id, 'log.txt'), 'utf8').trimEnd().split('\n').slice(-n).join('\n'));
  },

  async plan(id) { printPlan(Ops.get(id)); },
  async report(id) { console.log(fs.readFileSync(Job.file(Ops.get(id).id, 'report.md'), 'utf8')); },

  async approve(id) {
    Ops.approve(id, flag('--by') || process.env.SUDO_USER || os.userInfo().username);
    console.log(`approved; ${id} continues. ./ai status ${id} --watch`);
  },
  async reject(id) { Ops.reject(id); console.log(`rejected ${id}. ./ai discard ${id} removes its worktree and database.`); },
  async retry(id) { const from = flag('--from'); Ops.retry(id, from); console.log(`retrying ${id}${from ? ' from ' + from : ''}. ./ai status ${id} --watch`); },
  async cancel(id) { Ops.cancel(id); console.log(`cancelling ${id}`); },
  async discard(id) { await Ops.discard(id); console.log(`discarded ${id}`); },

  async takeover(id) {
    const t = await Ops.takeover(id);
    console.log(`Session ${t.session_id} is open in tmux session "${id}".\nAttach from the Terminal panel:\n\n  ${t.attach}\n\nDetach with Ctrl+B then D.${t.can_retry ? ` When done, ./ai retry ${id} continues the pipeline.` : ''}`);
  },

  async archive(id) { await Ops.archive(id); console.log(`archived ${id} (branch kept)`); },

  async cleanup() {
    const days = Number(flag('--days') ?? Ops.KEEP_DAYS), dryRun = args.includes('--dry-run');
    const ids = await Ops.cleanup({ days, dryRun });
    console.log(ids.length ? `${dryRun ? 'would archive' : 'archived'} (ended > ${days} days ago):\n  ${ids.join('\n  ')}` : `nothing older than ${days} days to archive`);
  },

  // Token usage per stage and model. With no job: totals per job.
  async tokens(id) {
    if (!id) {
      let sum = 0, cost = 0;
      for (const j of Ops.jobs().filter((x) => x.tokens)) {
        sum += Job.tokenCount(j.tokens.total); cost += j.tokens.total.cost_usd;
        console.log(`${num(Job.tokenCount(j.tokens.total)).padStart(6)}  ≈$${j.tokens.total.cost_usd.toFixed(2).padStart(5)}  ${j.id}`);
      }
      return console.log(`${num(sum).padStart(6)}  ≈$${cost.toFixed(2).padStart(5)}  total (API-price estimate; Max isn't billed per token)`);
    }
    const t = Ops.get(id).tokens || die('No token data for this job.');
    console.log(`total    ${tokenLine(t.total)}\n`);
    for (const [k, v] of Object.entries(t.by_stage)) console.log(`${k.padEnd(8)} ${tokenLine(v)}  [${v.calls} call${v.calls > 1 ? 's' : ''}]`);
    console.log('');
    for (const [k, v] of Object.entries(t.by_model)) console.log(`${k.padEnd(20)} ${tokenLine(v)}`);
  },

  async tick() { Ops.tick(); },
  async projects() { for (const n of projectNames()) console.log(n); },
};

const help = `usage: ./ai <command>
  start <project> <prompt...>   queue a job        list | status <job> [--watch] | log <job> [-n 80]
  plan <job>                    show the plan      approve <job> [--by name] | reject <job>
  retry <job> [--from preview] | cancel <job> | takeover <job> | report <job>
  archive <job>                 free preview/db/worktree, keep the branch
  discard <job>                 archive and delete the branch
  cleanup [--days 7] [--dry-run]  archive finished jobs older than N days
  tokens [job]                  token usage per stage/model (or per job)
  add-project <name> | projects`;

if (!commands[cmd]) { console.log(help); process.exit(cmd ? 1 : 0); }
try { await commands[cmd](...args); }
catch (e) { die(e.message); }
