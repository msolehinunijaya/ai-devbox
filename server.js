#!/usr/bin/env node
// AI Devbox dashboard: JSON API + the one-page UI (index.html). Listens on 127.0.0.1;
// nginx exposes it on the Tailscale IP only. Runs as the ai user (systemd: ai-dashboard.service).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, MAX_JOBS, host, project, projectNames, readJSON } from './lib/util.js';
import * as Job from './lib/job.js';
import * as Ops from './lib/ops.js';

process.title = 'ai-dashboard';   // on earlyoom's avoid list
const PORT = Number(process.env.PORT || 7070);
const ID = /^[a-z0-9-]{1,80}$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Requests must name this dashboard: blocks DNS-rebinding pages that resolve their own name to our IP.
function allowedHosts() {
  const h = host();
  return new Set([h.ts_ip, `ai.${h.domain}`, ...(h.names || []), `127.0.0.1:${PORT}`, `localhost:${PORT}`]);
}

// Who is calling, from Tailscale (nginx passes the peer address), for "approved by".
const who = new Map();
function whois(ip) {
  if (!ip) return Promise.resolve('dashboard');
  if (who.has(ip)) return Promise.resolve(who.get(ip));
  return new Promise((resolve) => execFile('tailscale', ['whois', '--json', ip], { timeout: 5000 }, (err, out) => {
    let name = `dashboard (${ip})`;
    try {
      const j = JSON.parse(out);
      const device = (j.Node?.ComputedName || j.Node?.Hostinfo?.Hostname || j.Node?.Name || '').replace(/\.$/, '');
      name = `${j.UserProfile.LoginName}${device ? ' on ' + device : ''}`;
    } catch {}
    who.set(ip, name);
    resolve(name);
  }));
}

function summary(j) {
  return {
    id: j.id, project: j.project, prompt: j.prompt, state: j.state, stage: j.stage, message: j.message,
    created_at: j.created_at, ended_at: j.ended_at, elapsed_s: j.elapsed_s, eta_s: j.eta_s, progress: j.progress,
    stages: Object.fromEntries(Job.STAGES.map((s) => [s, j.stages[s].state])),
    preview_url: j.preview_url, verdict: j.verdict, queue: Ops.queuePosition(j), archived_at: j.archived_at || null,
    tokens: Job.tokenCount(j.tokens?.total), cost_usd: j.tokens?.total.cost_usd || 0,
    tasks_done: j.tasks.filter((t) => t.state === 'done').length, tasks_total: j.tasks.length,
  };
}

function detail(j) {
  const f = (n) => Job.file(j.id, n);
  return {
    ...j, queue: Ops.queuePosition(j),
    plan: readJSON(f('plan.json'), null), review: readJSON(f('review.json'), null),
    report: fs.existsSync(f('report.md')) ? fs.readFileSync(f('report.md'), 'utf8') : null,
    shots: (j.shots || []).map(({ file, ...s }) => ({ ...s, url: `/api/jobs/${j.id}/shots/${path.basename(file)}` })),
  };
}

function job(id) {
  if (!ID.test(id) || !fs.existsSync(Job.file(id, 'status.json'))) throw new HttpError(404, `No job "${id}"`);
  return Ops.get(id);
}

// Latest Max-plan usage reported by any job.
function usage(all) {
  const withUsage = all.filter((j) => j.usage?.five_hour != null).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return withUsage[0]?.usage || null;
}

// Tokens and API-price estimate of jobs started today (server time).
function today(all) {
  const day = new Date().toDateString();
  const js = all.filter((j) => j.tokens && new Date(j.created_at).toDateString() === day);
  return { jobs: js.length, tokens: js.reduce((s, j) => s + Job.tokenCount(j.tokens.total), 0),
    cost_usd: js.reduce((s, j) => s + j.tokens.total.cost_usd, 0) };
}

async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 256e3) throw new HttpError(413, 'Request too large'); }
  try { return data ? JSON.parse(data) : {}; } catch { throw new HttpError(400, 'Body must be JSON'); }
}

const ACTIONS = {
  approve: async (id, req) => Ops.approve(id, await whois(req.headers['x-real-ip'])),
  reject: (id) => Ops.reject(id),
  retry: (id) => Ops.retry(id),
  cancel: (id) => Ops.cancel(id),
  archive: (id) => Ops.archive(id),
  discard: (id) => Ops.discard(id),
  takeover: (id) => Ops.takeover(id),
};

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const send = (status, data, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };

  if (!allowedHosts().has(req.headers.host)) throw new HttpError(421, 'Unknown host');
  if (req.method !== 'GET') {
    // Custom header + same-origin check: a web page elsewhere can't make the browser start jobs.
    const origin = req.headers.origin;
    if (req.headers['x-devbox'] !== '1' || (origin && !allowedHosts().has(new URL(origin).host))) throw new HttpError(403, 'Cross-site request refused');
  }

  if (req.method === 'GET' && parts.length === 0) {
    return send(200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
  }
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');

  if (req.method === 'GET' && parts[1] === 'state') {
    const all = Ops.jobs();
    return send(200, {
      projects: projectNames().map((n) => { const p = project(n); return { name: n, type: p.type, approve_plan: !!p.approve_plan, push: !!p.push }; }),
      jobs: all.reverse().map(summary), max_jobs: MAX_JOBS, running: all.filter((j) => j.state === 'running').length,
      usage: usage(all), today: today(all),
    });
  }
  if (parts[1] !== 'jobs') throw new HttpError(404, 'Not found');

  if (req.method === 'POST' && parts.length === 2) {
    const { project: name, prompt } = await body(req);
    if (!projectNames().includes(name)) throw new HttpError(400, `Unknown project "${name}"`);
    return send(201, summary(Ops.start(name, prompt)));
  }

  const [, , id, sub, file] = parts;
  if (req.method === 'GET' && parts.length === 3) return send(200, detail(job(id)));
  if (req.method === 'GET' && sub === 'log') {
    const lines = Math.min(1000, Number(url.searchParams.get('lines')) || 200);
    const f = Job.file(job(id).id, 'log.txt');
    return send(200, fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') : '', 'text/plain; charset=utf-8');
  }
  if (req.method === 'GET' && sub === 'shots' && /^[\w.-]+\.png$/.test(file || '')) {
    const f = Job.file(job(id).id, `shots/${file}`);
    if (!fs.existsSync(f)) throw new HttpError(404, 'No such screenshot');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
    return fs.createReadStream(f).pipe(res);
  }
  if (req.method === 'PUT' && sub === 'plan') {
    job(id);
    Ops.savePlan(id, (await body(req)).plan);
    return send(200, detail(job(id)));
  }
  if (req.method === 'POST' && ACTIONS[sub]) {
    job(id);
    const result = await ACTIONS[sub](id, req);
    return send(200, sub === 'takeover' ? result : detail(job(id)));
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 400;   // most failures are a job in the wrong state
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: e.message }));
  });
});

Ops.jobs();                       // marks jobs whose runner died while we were down as interrupted
Ops.tick();
setInterval(() => { try { Ops.tick(); } catch (e) { console.error('tick:', e.message); } }, 5000);
// Hourly: archive finished jobs older than AI_DEVBOX_KEEP_DAYS (default 7); branches are kept.
const cleanup = () => Ops.cleanup().then((ids) => ids.length && console.log(`archived: ${ids.join(', ')}`), (e) => console.error('cleanup:', e.message));
setTimeout(cleanup, 60e3);
setInterval(cleanup, 3600e3);
server.listen(PORT, '127.0.0.1', () => console.log(`AI Devbox dashboard on 127.0.0.1:${PORT}`));
