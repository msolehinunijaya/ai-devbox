// Screenshot helper: node snap.mjs <base-url> <user:pass|-> <out-dir> <path...>
// Takes desktop and mobile full-page shots of each path, prints one line per shot, and writes
// <out-dir>/shots.json. Run from a dir that has `playwright` in node_modules (tools/).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');

const [base, userPass, outDir, ...paths] = process.argv.slice(2);
const httpCredentials = userPass && userPass !== '-'
  ? { username: userPass.split(':')[0], password: userPass.split(':').slice(1).join(':') } : undefined;
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

// Flags keep Chromium lean on a 2 GB box
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
const shots = [];
try {
  for (const [label, viewport] of Object.entries(viewports)) {
    const ctx = await browser.newContext({ viewport, httpCredentials });
    const page = await ctx.newPage();
    for (const p of paths) {
      const slug = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
      const file = path.join(outDir, `${slug}-${label}.png`);
      const shot = { path: p, viewport: label, file, status: null, error: null };
      try {
        const res = await page.goto(base + p, { waitUntil: 'networkidle', timeout: 45000 });
        shot.status = res?.status() ?? null;
        await page.screenshot({ path: file, fullPage: true });
      } catch (e) {
        shot.error = e.message.split('\n')[0];
      }
      console.log(`${shot.status ?? 'ERR'} ${p} (${label})${shot.error ? ': ' + shot.error : ''}`);
      shots.push(shot);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify(shots, null, 2));
}
process.exit(shots.some((s) => s.error || !s.status || s.status >= 400) ? 2 : 0);
