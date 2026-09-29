# AI Devbox: one prompt → plan → review → build → test → preview, on the DO droplet

## Context

Today's loop is manual: prompt in plan mode → accept → tick checklist → check locally → commit by hand.
Goal: pick a project, type one prompt, walk away. The server plans, reviews the plan, executes task by task,
tests, takes screenshots, verifies against the plan, and hands back a **timeline (elapsed / ETA), screenshots,
and a live preview link**. Code lands on a branch `ai/<job>`; **you merge** (main is never touched).

Known facts:
- Droplet: 2 GB RAM. Already has Claude Code, nginx/PHP/MySQL, and project clones. Claude is on a **Max** plan.
- Local survey (C:\laragon\www): ~14 deployable apps, almost all **Laravel + MySQL**
  (Laravel 9–13 → one **PHP 8.3** covers them). 5 legacy apps need PHP 7.x (stods_*, emakmal2019*).
  Node-server / Next.js apps (OmniRoute, pdfcraft, hies-backend) → **not in v1**: OmniRoute alone wants 8 GB heap.
- Claude Code docs: headless `claude -p --output-format stream-json`, permission mode `auto`, `claude setup-token`
  for Max on a server, `--resume <session>`. Remote Control can only **attach to a running session**; it cannot
  start new ones. So a small dashboard starts jobs, and Remote Control is the "take over" door.

## Adjustments after the Phase 0 audit (2026-09-29)

Where this section disagrees with the rest of the plan, this section wins.

**Server facts:** Ubuntu 24.04.5, **1 vCPU**, 2 GB RAM, 4 GB swapfile already present, 35 GB disk free.
PHP 8.4 CLI+FPM (8.3 is CLI only), nginx 1.24, **MariaDB** 10.11 (buffer pool 128M and performance_schema OFF
already), Node 22, Claude Code 2.1.284. earlyoom runs and prefers killing `node`. ufw allows only 22, 80, 8081.
One project on the server: `/var/www/kkdw_v2.0` (owner `dev`, Laravel 13, GitLab). It is the **live site on :80**,
checked out on a feature branch with uncommitted work, and its DB is Cloud SQL via a proxy on 127.0.0.1:3307.
An earlier pipeline (`/ship`, `~/.claude/ai-pipeline/`) exists; it stays until the dashboard works.

**Changes:**
1. Everything lives in `/var/www/ai-devbox` (git repo on the server, root-owned). Runtime data goes in git-ignored
   `run/` and `repos/`, owned by `ai`. The agent can't edit the runner.
2. The runner keeps **its own clone per project** in `repos/` (cloned with `ai`'s SSH key) and makes worktrees from
   there. The user's checkouts and the live site are never touched.
3. Preview DB = **local MariaDB** `ai_<job>`, never Cloud SQL. MariaDB user `ai` authenticates by unix socket
   (no password) and only has rights on `ai\_%`. Preview `.env` is built from `.env.example` (no secrets), never
   copied from the real `.env`. Cache/session = file, queue = sync, mail = log.
4. PHP-FPM pool `[ai]` goes on the existing **php8.4-fpm** (runs as `ai`, `pm=ondemand`, max 4 children).
5. Swapfile and MariaDB tuning already done. Only swappiness 60 → 10.
6. `vendor/` is **copied with hard links**, never symlinked (Composer resolves the app root from vendor's real
   path); `vendor/composer/` gets a real copy because Composer rewrites it. `node_modules/` may be symlinked.
7. Reuse from `/ship`: project-type detection, dependency logic, and `snap.mjs` (desktop + mobile screenshots)
   instead of a new `shot.js`. Playwright lives in `tools/`, browsers in `tools/ms-playwright`.
8. ufw: `allow in on tailscale0`, so dashboard and previews are reachable over Tailscale only.
9. earlyoom: the dashboard sets its process name to `ai-dashboard`, which is on earlyoom's avoid list, and its
   systemd unit lowers its OOM score. Build steps (`node`) stay the preferred victims.
10. 1 vCPU: MAX_JOBS stays 2, but the heavy-step lock matters more. Interactive Claude sessions (~315 MB each)
    count against the same RAM.
11. **Plan approval gate**: per-project switch. When on, the job pauses after Review with Approve / Edit / Cancel.
    On for kkdw (its CLAUDE.md requires a human-approved technical plan), off otherwise.
12. Agent deny rules also cover `glab` and `gh`.
13. CLI: `--session-id <uuid>` chosen by the runner, `--json-schema` for plan/review output,
    `--permission-prompts none` so a headless job can't hang. Take over = `claude --resume <id> --remote-control`
    in tmux (confirm in Phase 2; fallback `--bg` + `claude attach`). Never `--bare` (API-key only).
14. Test projects: `kkdw_v2.0` replaces `kkdw_2026`; `ursb-ai` must be cloned before Phase 4.
15. `ai` runs Claude from `/opt/ai-devbox/bin/claude` (hard link to root's install, auto-update off); `setup.sh` refreshes it.
16. **Take over (Phase 2 finding):** Remote Control needs a full-scope login; `claude setup-token` tokens are
    inference-only. v1 take-over = `./ai takeover <job>` opens the job's last session in tmux, attached from the
    Terminal panel (`sudo -u ai -i tmux attach -t <job>`). Take-over from the phone needs `claude auth login`
    for the `ai` user, which leaves full-scope credentials readable by agent processes: decide before enabling.
17. Pipeline tests use a throwaway Laravel 13 app (`sandbox`, source `repos/_src/sandbox`, no gate, no push).
    kkdw stays registered but unused until you want it.

## Phase 4 measurements (2026-09-29)

Two jobs on two projects (sandbox: dark-mode toggle, 3 tasks; sandbox2: contact form + migration, 3 tasks) at the
same time, plus this Claude session and one interactive session. Sampled every 3 s (`tools/memwatch.mjs`) and `vmstat 5`.

| Measure | Result |
|---|---|
| Lowest MemAvailable | 370 MB of 1,967 (5 Claude processes, ~1.06 GB RSS together) |
| Swap used | 262 MB idle, 505 MB peak; bursts up to ~13 MB/s, no thrashing |
| CPU (1 vCPU) | saturated during builds/tests: run queue up to 13, load 5, idle 25% on average |
| Heavy-lock waits | 3 s in total: agents spend most of the time waiting on the API |
| Duration | 4m20s and 4m48s in parallel, vs ~4 min alone |
| Kills | none (earlyoom and kernel) |
| Dashboard restart mid-job | both runners kept running |
| Live kkdw latency during build+test | 0.275 s idle, 0.34 s under load (with or without nice: it's Cloud SQL-bound) |

Tuning applied: heavy steps run under `nice -n 10 ionice -c2 -n7`; a second job starts only while
MemAvailable >= 400 MB (`AI_DEVBOX_MIN_START_MB`), otherwise it waits in the queue with a message.
Kept: one global heavy lock, MAX_JOBS=2, 4 GB swap at swappiness 10, builds at `--max-old-space-size=1024`.
Real projects with bigger builds (kkdw: 403 MB node_modules) will need more headroom than the sandboxes;
each interactive Claude session costs ~300 MB of the same RAM.

## Your questions, answered

**Should I install Docker?** No, not on 2 GB. Docker would run PHP + MySQL per project; three containers eat the
RAM that two AI jobs need, and the daemon costs ~100 MB on its own. Your stack is ~90% Laravel+MySQL, so the
native setup is cheaper: one MySQL, one PHP 8.3-FPM pool for previews, nginx. Add `php7.4-fpm` (ondrej PPA)
the first time you pick a legacy project. **Add Docker when:** you resize to ≥4–8 GB, or a project needs something
that can't sit natively (Oracle client for sppipkpm, Next.js builds).

**What happens with 2 projects at the same time?** Each job gets its own git worktree, branch, preview database,
preview URL and `claude` process. No file or git collisions. They share three things:
1. **RAM.** The AI "thinking" happens at Anthropic; the droplet mostly waits. RAM spikes come from composer, vite,
   and the headless browser. Those heavy steps take a **global lock (one at a time)**, so 2 jobs run ~20–40%
   slower each rather than crashing.
2. **CPU.** Same effect: jobs wait on each other a little.
3. **Your Max usage limit.** Two autonomous jobs drain the 5-hour window faster. If a job hits the limit it pauses
   as "needs you" with a Retry button.

Rules: max **2 running jobs**; a 3rd queues. **1 job per project** at a time; a second one on the same project
queues, so you avoid merge conflicts.

**Optimize for 2 GB:** 4 GB swapfile (swappiness 10); MySQL `innodb_buffer_pool_size=128M` and
`performance_schema=OFF`; FPM `pm=ondemand` with max_children 4; reuse `vendor/` and `node_modules/` via symlink
unless the job changes the lock file; build assets only when frontend files changed; one Chromium at a time.
Rough peak: OS+nginx 250 MB + MySQL 250 MB + 2× claude ~300 MB each + one heavy step 400–900 MB ≈ 1.5–2.1 GB.
Swap absorbs the overshoot. These are estimates; Phase 0 and Phase 4 measure them. If you often run 2 jobs, resizing
to 4 GB (+$12/mo) is the cheapest speed-up.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Engine | Own thin runner (Node, stdlib only) spawning one `claude -p` per stage | Exact timeline/ETA, fresh context per task, no plugin dependency (GSD renames to /bm: on 2026-10-01). Upgrade to Agent SDK later if needed. |
| Control | Web dashboard to start and watch jobs + Remote Control "Take over" | Remote Control can't start sessions |
| Git | Commit per task on `ai/<job>`, runner pushes the branch, you merge | main never auto-touched |
| Access | **Tailscale** (free) on droplet + your PC/phone; dashboard and previews listen **only** on the Tailscale IP | The dashboard runs code on the server, so it must not be public. No domain, no cert needed. |
| Preview hostnames | `http://<job>.<tailscale-ip-dashed>.sslip.io` (free, no signup) | One wildcard nginx block serves every job |
| Models | plan/review/verify = `opus`, execute = `sonnet` | Stretches the Max limit |
| Permissions | `auto` for execute/verify; read-only (`dontAsk` + Read/Glob/Grep allowlist) for plan/review | Unattended but guarded. Runs as unprivileged user `ai`, no sudo; git push denied to the agent (the runner pushes). |

## Job lifecycle

| # | Stage | Who | Output |
|---|---|---|---|
| 1 | **Plan** | claude (opus, read-only). Reads CLAUDE.md / .planning if present. | `plan.json`: summary, tasks[{id, title, files, steps, verify_cmd, estimate_min}] (≤12 tasks, ≤30 min each), snapshots[{path, login}] |
| 2 | **Review** | claude (opus, read-only, fresh context) | `{approved}` or `{approved:false, plan:<corrected>}`. One round; the corrected plan is used. |
| 3 | **Execute** ×N | claude (sonnet, auto), one call per task | Implements the task, runs verify_cmd, commits `ai(<job>): <title>`. On failure: one `--resume` retry with the error, then "needs you". |
| 4 | **Preview up** | runner (no AI) | Deps (symlinked or installed under the lock); `.env` copy with APP_URL, `DB_DATABASE=ai_<job>`, **MAIL_MAILER=log**, QUEUE=sync; `migrate --seed`; build if frontend changed; docroot symlink |
| 5 | **Test** | runner (no AI) | `php artisan test` / `npm test` output + `shot.js` screenshots (logs in with a throwaway preview user when `login:true`) |
| 6 | **Verify** | claude (opus, auto) | Checks diff vs plan vs test results; fixes and re-tests, max 2 loops; writes `report.md` (pass/fail per task) |
| 7 | **Publish** | runner | Push branch, mark done, optional phone push via ntfy.sh with preview link |

**Timeline and ETA** (`status.json`, the dashboard polls it every 3 s): each stage and task records start, end and estimate.
`ETA = Σ(pending task estimates) × (actual/estimated ratio of finished tasks) + constants for remaining stages`.
The first ETA is the planner's guess and gets more accurate as tasks finish.

## Files to create (in `/var/www/ai-devbox`, the git repo on the server)

- `server.js`: HTTP API + static files + job queue (MAX_JOBS=2, 1 per project) + stage runner (spawns `claude -p`,
  parses stream-json, captures session_id, writes status.json). On restart, running jobs are marked "interrupted".
- `index.html`: vanilla JS dashboard. **Start page:** project picker (git dirs in PROJECTS_DIR) + prompt + Start; job list.
  **Job page:** progress bar, elapsed/ETA, timeline bars per stage/task, live log tail, screenshot grid, preview link,
  report, and buttons Take over / Cancel / Retry / Discard (removes worktree, DB, branch).
- `tools/snap.mjs`: the `/ship` screenshot script (desktop + mobile), extended with an optional /login form fill.
- `prompts/{plan,review,execute,verify}.md`: stage instructions + output contract.
- `setup.sh`: one-time idempotent setup: swap, `ai` user, Tailscale, FPM pool `[ai]`, MySQL tuning, Playwright
  Chromium, `ai` user's `~/.claude/settings.json` deny rules (`git push`, `sudo`, `~/.ssh`).
- `nginx-ai.conf`: wildcard preview server bound to the Tailscale IP, root `/var/www/ai-devbox/run/docroot/$job` (symlink to `public/` or repo root).
- `ai-dashboard.service`: systemd unit, `EnvironmentFile` (chmod 600) holding `CLAUDE_CODE_OAUTH_TOKEN`.

**Take over:** `tmux new -d "cd <worktree> && claude --resume <sid>"` with Remote Control enabled. The job then shows up in your
Claude app. Exact flag confirmed from `claude --help` in Phase 0.

## Build phases (rough estimates)

0. **Server audit, read-only (15 min).** Needs your SSH host/user. Check `free -m`, `ps` memory, php/nginx/mysql/node/claude versions,
   where the projects live, and what nginx already serves, so nothing existing breaks. Measure one idle `claude` process.
1. **Server prep (1 h):** setup.sh, Tailscale login (you approve it in your Tailscale app), SSH key for `ai` added by you
   to GitHub/GitLab with write access.
2. **Runner + prompts, CLI only (2–3 h):** run end-to-end on kkdw_2026 with a tiny prompt.
3. **Dashboard (2 h).**
4. **Concurrency + 2 GB tuning (1 h):** two jobs on two projects, watch `vmstat 5`, tune the lock and swap.
5. **Hardening (30 min):** cleanup for jobs older than 7 days (manual Discard in v1), ntfy optional.

## Verification

1. Job on kkdw_2026: "add app version to the footer". Expect ≤3 tasks, timeline fills in, ETA converges, screenshot shows the footer,
   the preview URL opens from your phone over Tailscale, branch `ai/<job>` exists on gitlab.com, main is unchanged.
2. Deliberately failing prompt → verify loop tries a fix, then "needs you" → Take over opens in the Claude app.
3. Two jobs in parallel (kkdw_2026 + ursb-ai): both finish, no OOM in `dmesg`, swap peak recorded.
4. Same project twice → second job queues.
5. From outside Tailscale (phone on mobile data with Tailscale off): dashboard and previews are unreachable.

## Not in v1 (add when needed)

PHP 7.4 pool for legacy apps; Node-server previews (PM2 per job); cloning real DB data into previews (v1 uses migrate --seed);
auto-creating PR/MR (`gh`/`glab`); Docker; per-project historical ETA.
