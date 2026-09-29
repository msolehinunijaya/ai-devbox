// Run one headless `claude -p` call for a job stage, streaming its events into the job log.
import fs from 'node:fs';
import { CLAUDE_BIN, SETTINGS, sh, tail } from './util.js';
import * as Job from './job.js';

const READ_ONLY = ['Read', 'Glob', 'Grep'];

// One-line summary of a tool call for the human log.
function describe(name, input = {}) {
  const arg = input.file_path || input.command || input.pattern || input.path || input.url || input.description || '';
  return `${name} ${String(arg).replace(/\s+/g, ' ').slice(0, 140)}`.trim();
}

/**
 * readOnly: plan/review agents get only Read/Glob/Grep. Otherwise the agent runs in auto mode,
 * where the classifier decides and anything that would need a prompt is denied (nobody is watching).
 * Resolves { ok, kind, text, data, sessionId, costUsd, denials, error }; kind is 'usage_limit' when the
 * Max plan limit was hit, so the job can pause instead of failing.
 */
export async function claude(job, { label, cwd, prompt, model, readOnly = false, schema, sessionId, resume, timeoutMs = 45 * 60e3 }) {
  const args = ['-p', '--model', model, '--permission-prompts', 'none',
    '--output-format', 'stream-json', '--verbose', '--settings', SETTINGS];
  if (readOnly) args.push('--tools', READ_ONLY.join(','), '--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY.join(' '));
  else args.push('--permission-mode', 'auto');
  if (resume) args.push('--resume', resume); else args.push('--session-id', sessionId);
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  const raw = fs.createWriteStream(Job.file(job.id, `logs/${label}.jsonl`), { flags: 'a' });
  let result = null, lastUsageSave = 0;
  const onLine = (line) => {
    raw.write(line + '\n');
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_use' && c.name !== 'StructuredOutput') Job.log(job, `  [${label}] ${describe(c.name, c.input)}`);
        if (c.type === 'text' && c.text.trim()) Job.log(job, `  [${label}] ${c.text.trim().split('\n')[0].slice(0, 200)}`);
      }
    } else if (ev.type === 'rate_limit_event') {
      const w = ev.rate_limit_info?.unifiedWindows || {};
      job.usage = { status: ev.rate_limit_info?.status, five_hour: w.five_hour?.utilization, seven_day: w.seven_day?.utilization,
        resets_at: w.five_hour?.resetsAt ? new Date(w.five_hour.resetsAt * 1000).toISOString() : null };
      if (Date.now() - lastUsageSave > 30e3) { lastUsageSave = Date.now(); Job.save(job); }
    } else if (ev.type === 'result') {
      result = ev;
    }
  };

  const { code, out } = await sh(CLAUDE_BIN, args, { cwd, input: prompt, timeoutMs, onLine });
  raw.end();
  if (!result) return { ok: false, kind: 'crash', error: `claude exited ${code} without a result:\n${tail(out, 20)}` };

  Job.addTokens(job, label, result);
  const text = String(result.result ?? '');
  const limited = result.api_error_status === 429 || job.usage?.status === 'rejected'
    || (result.is_error && /usage limit|rate limit|limit reached|out of (credits|usage)/i.test(text));
  const ok = !result.is_error && result.subtype === 'success' && (!schema || result.structured_output);
  return {
    ok, kind: ok ? 'ok' : limited ? 'usage_limit' : 'error', text,
    data: result.structured_output, sessionId: result.session_id, costUsd: result.total_cost_usd,
    denials: result.permission_denials || [],
    error: ok ? null : (schema && !result.structured_output && !result.is_error ? 'No structured output returned' : text.slice(0, 1000)),
  };
}
