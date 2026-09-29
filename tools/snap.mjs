// Screenshot helper: node snap.mjs <base-url> <user:pass> <out-dir> <path...>
// Run from a project dir that has `playwright` in node_modules.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');

const [base, userPass, outDir, ...paths] = process.argv.slice(2);
const [username, password] = userPass.split(':');
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

// Flags keep Chromium lean on a 2 GB box
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
let failures = 0;
try {
  for (const [label, viewport] of Object.entries(viewports)) {
    const ctx = await browser.newContext({ viewport, httpCredentials: { username, password } });
    const page = await ctx.newPage();
    for (const p of paths) {
      const slug = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
      const file = path.join(outDir, `${slug}-${label}.png`);
      try {
        const res = await page.goto(base + p, { waitUntil: 'networkidle', timeout: 45000 });
        await page.screenshot({ path: file, fullPage: true });
        console.log(`${res?.status() ?? '?'} ${p} (${label}) -> ${file}`);
        if (!res || res.status() >= 400) failures++;
      } catch (e) {
        failures++;
        console.log(`ERR ${p} (${label}): ${e.message.split('\n')[0]}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failures ? 2 : 0);
