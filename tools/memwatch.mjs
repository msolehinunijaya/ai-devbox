#!/usr/bin/env node
// Samples free memory, swap, load and RSS per process type, for tuning jobs on a 2 GB server.
// Usage: node tools/memwatch.mjs [interval_s=3] [out.csv]   Stop with Ctrl+C or SIGTERM to print the peaks.
// RSS counts shared pages once per process, so group totals are an upper bound.
import fs from 'node:fs';

const intervalMs = Number(process.argv[2] || 3) * 1000;
const csv = process.argv[3] ? fs.createWriteStream(process.argv[3], { flags: 'a' }) : process.stdout;
const GROUPS = ['claude', 'node', 'chromium', 'php', 'mariadb', 'other'];

function group(name) {
  if (/^(claude|\d+\.\d+\.\d+)$/.test(name)) return 'claude';   // the ccd CLI shows up as its version number
  if (/^(node|ai-runner|ai-dashboard|npm|npx)/.test(name)) return 'node';
  if (/chrom|headless/.test(name)) return 'chromium';
  if (/^php/.test(name)) return 'php';
  if (/^(mariadbd|mysqld)$/.test(name)) return 'mariadb';
  return 'other';
}

const mb = (kb) => Math.round(kb / 1024);
const peak = { avail_min: Infinity, swap_max: 0, load_max: 0, claude_n_max: 0, ...Object.fromEntries(GROUPS.map((g) => [g, 0])) };

function sample() {
  const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').trim().split('\n')
    .map((l) => { const [k, v] = l.split(':'); return [k, parseInt(v, 10)]; }));
  const rss = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  let claudeN = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const kb = st.match(/^VmRSS:\s+(\d+)/m);
      if (!kb) continue;
      const g = group(st.match(/^Name:\s+(.*)$/m)[1]);
      rss[g] += Number(kb[1]);
      if (g === 'claude') claudeN++;
    } catch {}   // process exited while we read it
  }
  const row = {
    time: new Date().toTimeString().slice(0, 8), avail: mb(mem.MemAvailable), swap_used: mb(mem.SwapTotal - mem.SwapFree),
    load: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), claude_n: claudeN,
    ...Object.fromEntries(GROUPS.map((g) => [g, mb(rss[g])])),
  };
  peak.avail_min = Math.min(peak.avail_min, row.avail);
  peak.swap_max = Math.max(peak.swap_max, row.swap_used);
  peak.load_max = Math.max(peak.load_max, row.load);
  peak.claude_n_max = Math.max(peak.claude_n_max, claudeN);
  for (const g of GROUPS) peak[g] = Math.max(peak[g], row[g]);
  csv.write(Object.values(row).join(',') + '\n');
}

csv.write(`time,avail_mb,swap_used_mb,load1,claude_procs,${GROUPS.map((g) => g + '_mb').join(',')}\n`);
sample();
const timer = setInterval(sample, intervalMs);
const stop = () => { clearInterval(timer); console.error('peaks:', JSON.stringify(peak)); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
