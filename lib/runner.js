// Drives one job through its stages. Resumable: finished stages and tasks are skipped, so the same
// entry point handles a new job, "approve", "retry" and a restart after a crash.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODELS, project, render, schema, now, git, sh, tail, killChildren, onLockWait, readJSON, writeJSON } from './util.js';
import { claude } from './claude.js';
import * as Job from './job.js';
import * as Project from './project.js';
import { tick } from './ops.js';
import { notify } from './notify.js';

const MAX_VERIFY_ROUNDS = 3;   // up to 2 rounds may fix things; the last one only reports

const need = (message) => ({ need: message });
const planFile = (job) => Job.file(job.id, 'plan.json');
const loadPlan = (job) => readJSON(planFile(job));
const head = (job) => git(job.worktree, 'rev-parse', '--short', 'HEAD');

function tasksFromPlan(job, plan) {
  const old = Object.fromEntries(job.tasks.map((t) => [t.id, t]));
  job.tasks = plan.tasks.map((t) => ({
    id: t.id, title: t.title, estimate_min: t.estimate_min, state: 'pending',
    ...(old[t.id]?.state === 'done' ? old[t.id] : {}),
  }));
}

// A failed Claude call becomes "needs you"; hitting the Max usage limit gets its own message.
function claudeFailure(stage, r) {
  if (r.kind === 'usage_limit') return need('Claude usage limit reached. Press Retry after the limit resets.');
  return need(`${stage}: Claude call failed: ${r.error}`);
}

async function commitLeftovers(job, message) {
  const dirty = (await git(job.worktree, 'status', '--porcelain')).trim();
  if (!dirty) return false;
  await git(job.worktree, 'add', '-A');
  await git(job.worktree, 'commit', '--quiet', '-m', message);
  return true;
}

const STAGE = {
  async setup(job, p, say) {
    await Project.setup(job, p, say);
  },

  async plan(job, p) {
    const r = await claude(job, {
      label: 'plan', cwd: job.worktree, model: MODELS.plan, readOnly: true, schema: schema('plan'),
      sessionId: (job.stages.plan.session_id = randomUUID()), timeoutMs: 20 * 60e3,
      prompt: render('plan', { PROJECT: p.name, TYPE: p.type, BASE: job.base, REQUEST: job.prompt }),
    });
    if (!r.ok) return claudeFailure('plan', r);
    writeJSON(planFile(job), r.data);
    tasksFromPlan(job, r.data);
  },

  async review(job, p, say) {
    const planSchema = schema('plan');
    const r = await claude(job, {
      label: 'review', cwd: job.worktree, model: MODELS.review, readOnly: true,
      schema: {
        type: 'object', additionalProperties: false, required: ['approved', 'issues'],
        properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } }, plan: planSchema },
      },
      sessionId: (job.stages.review.session_id = randomUUID()), timeoutMs: 15 * 60e3,
      prompt: render('review', { REQUEST: job.prompt, PLAN: JSON.stringify(loadPlan(job), null, 2) }),
    });
    if (!r.ok) return claudeFailure('review', r);
    writeJSON(Job.file(job.id, 'review.json'), r.data);
    if (!r.data.approved && r.data.plan) {
      fs.copyFileSync(planFile(job), Job.file(job.id, 'plan.original.json'));
      writeJSON(planFile(job), r.data.plan);
      tasksFromPlan(job, r.data.plan);
      say(`reviewer corrected the plan: ${r.data.issues.join(' | ')}`);
    } else {
      say(r.data.approved ? 'reviewer approved the plan' : `reviewer raised issues but sent no corrected plan: ${r.data.issues.join(' | ')}`);
    }
  },

  // Human gate (per project). The job stops here; `approve` records who approved and resumes it.
  async approve(job, p) {
    if (!p.approve_plan) return { skip: 'this project does not require plan approval' };
    if (job.approved_by) { tasksFromPlan(job, loadPlan(job)); return; }   // plan.json may have been edited before approving
    return { wait: 'Plan ready: approve, edit or cancel.' };
  },

  async execute(job, p, say) {
    const plan = loadPlan(job);
    for (const task of job.tasks) {
      if (task.state === 'done') continue;
      const spec = plan.tasks.find((t) => t.id === task.id);
      const vars = {
        PROJECT: p.name, BRANCH: job.branch, JOB: job.id, REQUEST: job.prompt, SUMMARY: plan.summary,
        DB: Project.dbName(job.id), TITLE: spec.title, VERIFY_CMD: spec.verify_cmd,
        TASK: JSON.stringify(spec, null, 2),
        DONE: job.tasks.filter((t) => t.state === 'done').map((t) => `${t.id} ${t.title} (${t.commit})`).join('; ') || 'none',
        APPROVAL: job.approved_by
          ? `A human (${job.approved_by}) approved this plan at ${job.approved_at}.`
          : 'The plan was checked by an AI reviewer; this project does not require human plan approval.',
      };
      Object.assign(task, { state: 'running', started_at: now(), ended_at: null, attempts: (task.attempts || 0) + 1 });
      task.session_id = randomUUID();
      Job.save(job);
      say(`task ${task.id}: ${task.title}`);

      let r = await claude(job, { label: `task-${task.id}`, cwd: job.worktree, model: MODELS.execute, sessionId: task.session_id, prompt: render('execute', vars) });
      if (!r.ok) { task.state = 'failed'; return claudeFailure(`task ${task.id}`, r); }
      let check = await checkTask(job, spec);
      if (!check.ok) {
        say(`task ${task.id}: check failed (exit ${check.code}), one retry`);
        r = await claude(job, {
          label: `task-${task.id}-retry`, cwd: job.worktree, model: MODELS.execute, resume: task.session_id,
          prompt: render('execute-retry', { ...vars, CODE: check.code, OUTPUT: tail(check.out, 60) }),
        });
        if (!r.ok) { task.state = 'failed'; return claudeFailure(`task ${task.id} retry`, r); }
        check = await checkTask(job, spec);
        if (!check.ok) {
          task.state = 'failed';
          return need(`Task ${task.id} "${task.title}": its check still fails after one retry (\`${spec.verify_cmd}\`, exit ${check.code}).`);
        }
      }
      if (await commitLeftovers(job, `ai(${job.id}): ${spec.title}`)) say(`task ${task.id}: committed changes the agent left uncommitted`);
      Object.assign(task, { state: 'done', ended_at: now(), commit: await head(job) });
      Job.save(job);
    }
  },

  async preview(job, p, say) {
    const r = await Project.preview(job, p, say);
    job.preview_notes = r.notes;
    say(`preview ${r.ok ? 'up' : 'has problems'}: ${job.preview_url}`);
  },

  async test(job, p, say) {
    job.tests = await Project.runTests(job, p, say);
    const plan = loadPlan(job);
    const paths = [...new Set([...(p.snapshots || []), ...plan.snapshots.filter((s) => !s.login).map((s) => s.path)])].slice(0, 6);
    const skipped = plan.snapshots.filter((s) => s.login).map((s) => s.path);
    if (skipped.length) say(`screenshots skipped (need login, not set up for this project): ${skipped.join(' ')}`);
    job.shots = paths.length ? await Project.snapshots(job, paths, say) : [];
  },

  // Verify, and when the verifier committed fixes, rebuild the preview, rerun the tests and verify again.
  async verify(job, p, say) {
    const plan = loadPlan(job);
    while (job.verify_rounds < MAX_VERIFY_ROUNDS) {
      const round = job.verify_rounds + 1;
      const before = await head(job);
      const r = await claude(job, {
        label: `verify-${round}`, cwd: job.worktree, model: MODELS.verify, schema: schema('verify'),
        sessionId: (job.stages.verify.session_id = randomUUID()), timeoutMs: 30 * 60e3,
        prompt: render('verify', {
          ROUND: round, MAX_ROUNDS: MAX_VERIFY_ROUNDS, BRANCH: job.branch, BASE: job.base, BASE_SHA: job.base_sha,
          REQUEST: job.prompt, PLAN: JSON.stringify(plan, null, 2), PREVIEW_URL: job.preview_url,
          COMMITS: await git(job.worktree, 'log', '--format=%h %s', `${job.base_sha}..HEAD`) || '(none)',
          DIFFSTAT: await git(job.worktree, 'diff', '--stat', `${job.base_sha}...HEAD`) || '(no changes)',
          TESTS: (job.tests || []).map((t) => `$ ${t.cmd}  -> exit ${t.code} (${t.secs}s)\n${t.tail}`).join('\n\n') || '(no test commands configured)',
          PREVIEW: (job.preview_notes || []).join('\n'),
          SHOTS: (job.shots || []).map((s) => `${s.file}  (${s.path}, ${s.viewport}, HTTP ${s.status ?? 'error: ' + s.error})`).join('\n') || '(none)',
          FIX_RULE: round < MAX_VERIFY_ROUNDS
            ? `If something is wrong and you can fix it in this worktree, fix it, run the relevant tests, and commit with the message \`ai(${job.id}): fix <what>\`. The pipeline then rebuilds the preview, reruns the tests and verifies again.`
            : 'This is the final round: do not change any code, only report.',
        }),
      });
      if (!r.ok) return claudeFailure(`verify round ${round}`, r);
      job.verify_rounds = round;
      job.verify = r.data;
      writeJSON(Job.file(job.id, `verify-${round}.json`), r.data);
      await commitLeftovers(job, `ai(${job.id}): fix from verify round ${round}`);
      const changed = (await head(job)) !== before;
      say(`verify round ${round}: ${r.data.verdict}${changed ? ' (committed fixes)' : ''}`);
      if (!changed || round === MAX_VERIFY_ROUNDS) break;
      await STAGE.preview(job, p, say);
      await STAGE.test(job, p, say);
      Job.save(job);
    }
    job.verdict = job.verify.verdict;
    writeReport(job, plan);
    if (job.verdict !== 'pass') return need(`Verifier verdict: fail. ${job.verify.summary}`);
  },

  async publish(job, p, say) {
    if (!p.push) return { skip: 'pushing is off for this project (no deploy key yet); the branch stays on the server' };
    const r = await sh('git', ['push', '--quiet', '-u', 'origin', job.branch], { cwd: job.worktree, timeoutMs: 5 * 60e3 });
    if (r.code) return need(`git push failed:\n${tail(r.out, 10)}`);
    say(`pushed ${job.branch}`);
  },
};

async function checkTask(job, spec) {
  if (!spec.verify_cmd || spec.verify_cmd.trim() === 'true') return { ok: true, code: 0, out: '' };
  const r = await sh('bash', ['-c', spec.verify_cmd], { cwd: job.worktree, heavy: true, timeoutMs: 15 * 60e3 });
  return { ok: r.code === 0, code: r.code, out: r.out };
}

function writeReport(job, plan) {
  const v = job.verify, icon = { pass: '✅', partial: '🟡', fail: '❌' };
  const byId = Object.fromEntries((v.tasks || []).map((t) => [t.id, t]));
  const mins = (s) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const lines = [
    `# ${icon[v.verdict]} ${job.id}`, '',
    `**Request:** ${job.prompt}`, '',
    `| | |`, `|---|---|`,
    `| Verdict | ${v.verdict.toUpperCase()} after ${job.verify_rounds} verify round(s) |`,
    `| Branch | \`${job.branch}\` from \`${job.base}\` |`,
    `| Preview | ${job.preview_url} |`,
    `| Elapsed | ${mins(Math.round((Date.now() - Date.parse(job.created_at)) / 1000))} |`, '',
    '## Summary', '', v.summary, '',
    '## Tasks', '', '| Task | Result | Note |', '|---|---|---|',
    ...plan.tasks.map((t) => `| ${t.id} ${t.title} | ${icon[byId[t.id]?.status] || '?'} | ${(byId[t.id]?.note || '').replace(/\|/g, '\\|')} |`), '',
    '## Tests', '', ...(job.tests || []).map((t) => `- \`${t.cmd}\`: exit ${t.code} (${t.secs}s)`), '',
    '## Screenshots', '', ...(job.shots || []).map((s) => `- ${s.path} (${s.viewport}): HTTP ${s.status ?? s.error} → \`${path.basename(s.file)}\``), '',
  ];
  if (v.followups?.length) lines.push('## Follow-ups', '', ...v.followups.map((f) => `- ${f}`), '');
  if (job.tokens) {
    const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
    const row = (name, t) => `| ${name} | ${k(t.output)} | ${k(t.input)} | ${k(t.cache_read)} | ${k(t.cache_write)} | ${k(Job.tokenCount(t))} | $${t.cost_usd.toFixed(2)} |`;
    lines.push('## Token usage', '', '| Stage | Output | Input | Cache read | Cache write | Total | API-price estimate |', '|---|---|---|---|---|---|---|',
      ...Object.entries(job.tokens.by_stage).map(([s, t]) => row(s, t)), row('**total**', job.tokens.total), '',
      'Up to the verify step; the Max plan is not billed per token.', '');
  }
  fs.writeFileSync(Job.file(job.id, 'report.md'), lines.join('\n'));
}

export async function run(id) {
  process.title = 'ai-runner';   // on earlyoom's avoid list; its children (claude, builds) are not
  try { fs.writeFileSync('/proc/self/oom_score_adj', '0'); } catch {}   // don't pass the dashboard's protection on
  await runStages(id);
  await notify(Job.load(id));   // approval needed, needs you, failed or done
  tick();   // a slot may have opened: start the next queued job
}

async function runStages(id) {
  const job = Job.load(id);
  const p = project(job.project);
  const say = (text) => Job.log(job, text);
  let current = null;
  onLockWait((ms, what) => {
    job.lock_wait_s = Math.round((job.lock_wait_s || 0) + ms / 1000);
    if (ms > 3000) say(`  waited ${Math.round(ms / 1000)}s for the heavy-step lock: ${what}`);
  });

  const stop = (signal) => {
    killChildren();
    job.state = 'cancelled';
    job.message = `Cancelled (${signal})`;
    job.ended_at = now();
    if (current) job.stages[current].state = 'cancelled';
    say('■ cancelled');
    Job.save(job);
    tick();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  Object.assign(job, { state: 'running', pid: process.pid, message: '', ended_at: null });
  Job.save(job);
  try {
    for (const s of Job.STAGES) {
      const st = job.stages[s];
      if (st.state === 'done' || st.state === 'skipped') continue;
      current = s;
      Object.assign(st, { state: 'running', started_at: now(), ended_at: null });
      job.stage = s;
      Job.save(job);
      say(`▶ ${s}`);
      const out = (await STAGE[s](job, p, say)) || {};
      if (out.wait) {
        Object.assign(st, { state: 'waiting' });
        Object.assign(job, { state: 'awaiting_approval', message: out.wait, pid: null });
        say(`⏸ ${out.wait}`);
        return Job.save(job);
      }
      if (out.need) {
        Object.assign(st, { state: 'failed', ended_at: now() });
        Object.assign(job, { state: 'needs_you', message: out.need, pid: null });
        say(`✋ needs you: ${out.need}`);
        return Job.save(job);
      }
      Object.assign(st, { state: out.skip ? 'skipped' : 'done', ended_at: now(), note: out.skip });
      if (out.skip) say(`  skipped: ${out.skip}`);
      Job.save(job);
    }
    Object.assign(job, { state: 'done', stage: null, pid: null, ended_at: now(),
      message: job.verdict === 'pass' ? 'Done: verified. Review the branch and merge when happy.' : 'Done.' });
    say('✔ done');
  } catch (e) {
    if (current) Object.assign(job.stages[current], { state: 'failed', ended_at: now() });
    Object.assign(job, { state: 'failed', message: e.message.slice(0, 2000), pid: null, ended_at: now() });
    say(`✖ failed: ${e.message}`);
  }
  Job.save(job);
}
