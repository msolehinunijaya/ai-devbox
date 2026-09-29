// Phone notifications through ntfy (https://ntfy.sh), when AI_DEVBOX_NTFY_TOPIC is set
// (/etc/ai-devbox/ntfy.env). The topic name is the only secret: anyone who knows it can read the notices.
import { host } from './util.js';

const NOTICE = {
  awaiting_approval: { title: 'Plan ready for approval', tags: 'clipboard', priority: 4 },
  needs_you: { title: 'Job needs you', tags: 'warning', priority: 4 },
  failed: { title: 'Job failed', tags: 'x', priority: 4 },
  done: { title: 'Job done', tags: 'white_check_mark', priority: 3 },
};

export async function notify(job) {
  const topic = process.env.AI_DEVBOX_NTFY_TOPIC;
  const n = NOTICE[job.state];
  if (!topic || !n) return;
  const server = (process.env.AI_DEVBOX_NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const prompt = job.prompt.length > 80 ? job.prompt.slice(0, 79) + '…' : job.prompt;
  const title = job.state === 'done' && job.verdict === 'pass' ? 'Job done and verified' : n.title;
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      // Only the project, prompt start and state leave the server; the links work only over Tailscale.
      headers: { Title: `${title}: ${job.project}`, Tags: n.tags, Priority: String(n.priority), Click: `http://${host().names?.[0] || host().ts_ip}/#/job/${job.id}` },
      body: prompt,
      signal: AbortSignal.timeout(10e3),
    });
    if (!res.ok) console.error(`ntfy: HTTP ${res.status}`);
  } catch (e) {
    console.error(`ntfy: ${e.message}`);   // a notification must never break a job
  }
}
