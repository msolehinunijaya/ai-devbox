# AI Devbox

Pick a project, type one prompt, walk away. The server plans the change, has the plan reviewed, builds
it task by task, starts a preview, runs the tests, takes screenshots, verifies the result against the
plan, and hands back a timeline, screenshots and a live preview link. Work lands on a branch `ai/<job>`;
you merge it. Base branches are never touched.

Runs on one 2 GB / 1 vCPU droplet, on your Claude Max subscription (no API billing), reachable only
over Tailscale. See [PLAN.md](PLAN.md) for the design, decisions and measurements.

## Use it

**Dashboard:** open `http://claude-dev/` (or `http://100.103.68.10/`) from a device on your tailnet.
Start a job, watch the timeline, approve plans, open previews, take over a session.

**Command line** (on the server, as root or `ai`):

```
./ai start sandbox "Add an About page at /about"   queue a job
./ai list                                          all jobs
./ai status <job> --watch                          timeline, ETA, last log lines
./ai plan <job>        ./ai approve <job>          review / approve a plan (projects with the gate on)
./ai retry <job> [--from preview]  ./ai cancel <job>  resume (or rerun from a stage) / stop it
./ai takeover <job>                                open the job's Claude session in tmux
./ai archive <job>     ./ai discard <job>          free disk (keep branch) / delete everything
./ai cleanup --dry-run                             what the hourly cleanup would archive
./ai tokens [job]                                  token usage per job, or per stage/model for one job
```

Previews: `http://<job>.100-103-68-10.sslip.io/`, served by PHP-FPM as `ai`, on the job's own MariaDB database.

## A job

The full flow, with what the AI does and every fallback, is in [docs/FLOW.md](docs/FLOW.md).

| Stage | Who | What |
|---|---|---|
| setup | runner | worktree on `ai/<job>` from the latest base, dependencies (hard-linked `vendor/`, shared `node_modules/`), `.env` from `.env.example` |
| plan | Claude opus, read-only | `plan.json`: tasks with files, steps, a check command and an estimate; pages to screenshot |
| review | Claude opus, read-only, fresh session | approves or returns a corrected plan |
| approve | you | only for projects with `"approve_plan": true` |
| execute | Claude sonnet, auto mode, one session per task | implements, runs the task's check, commits; one retry, then "needs you" |
| preview | runner | database `ai_<job>`, `migrate:fresh --seed`, frontend build (cached when untouched), docroot link |
| test | runner | the project's test commands + desktop/mobile screenshots |
| verify | Claude opus, auto mode | checks diff, tests and screenshots against the plan; may fix and re-verify (max 3 rounds) |
| publish | runner | pushes the branch when `"push": true` |

Token usage (output, input, cache read/write, and Claude Code's API-list-price estimate) is recorded
per call and shown per stage and model on the job page, in `report.md` and in the header (today's total).
The Max plan isn't billed per token; jobs count toward its 5-hour and 7-day limits.

At most 2 jobs run at once, one per project; a second job also waits until 400 MB of memory is free.
Composer, npm, builds, tests and the browser take one global lock and run at low CPU/IO priority.
Finished jobs are archived after 7 days (preview, database and worktree removed; branch kept).

## Layout

```
ai, cli.js          command line (./ai re-runs itself as the ai user with the token)
server.js           dashboard API + index.html, on 127.0.0.1:7070 behind nginx
lib/runner.js       the stages          lib/project.js   clone, worktree, deps, preview, tests, screenshots
lib/ops.js          job actions + queue lib/claude.js    one headless `claude -p` call per stage
lib/job.js          status.json, ETA    lib/notify.js    ntfy phone notifications
prompts/            stage prompts and their JSON schemas
config/             projects.json, Claude deny rules, nginx, PHP-FPM pool, systemd unit
tools/              snap.mjs (screenshots), memwatch.mjs (memory sampler), Playwright
setup.sh            idempotent server setup; re-run after Tailscale or Claude Code changes
run/, repos/        runtime data owned by ai (git-ignored): jobs, worktrees, clones, dependency caches
```

## Add a project

Add an entry to `config/projects.json`, then `./ai add-project <name>`:

```jsonc
"myapp": {
  "source": "/var/www/myapp",                        // local checkout or git URL
  "remote": "git@gitlab.com:group/myapp.git",       // push URL (needs the ai deploy key)
  "base": "main", "type": "laravel",
  "approve_plan": true, "push": false,
  "deps_from": "/var/www/myapp",                    // copy vendor/node_modules from here when lock files match
  "env": { "SOME_FLAG": "false" },                  // extra .env values for previews
  "tests": ["php artisan test"], "snapshots": ["/"],
  "setup": ["php artisan wayfinder:generate --with-form"],   // after the worktree is ready (git-ignored generators)
  "preview_login": { "path": "/login", "email": "preview@devbox.test" },   // seeded user; screenshots sign in
  "ui": "Frontend notes for the agents: layouts, component library, where nav links go"
}
```

Every plan, build and verify prompt includes `prompts/ui-standard.md` plus the project's `ui` notes, and the
verifier fails pages whose screenshots look unfinished. Agents can use the `frontend-design` skill
(`config/skills/`, installed for `ai` by `setup.sh`).

v1 supports Laravel only. The runner works in its own clone (`repos/<name>`); your checkout is never changed.

## Security

- Everything runs as the unprivileged `ai` user; it can't read other users' `.env` files or use sudo.
- Agents can't `git push`, `sudo`, `glab`, `gh` or read `~/.ssh` (`config/claude-settings.json`, passed on every call).
  Plan and review agents only get Read/Glob/Grep.
- Preview databases use socket auth for `ai` and only `ai_*` databases; `.env` files are built from `.env.example`.
- Dashboard and previews listen on the Tailscale IP only. The API refuses unknown hostnames and cross-site writes.
- Secrets live in `/etc/ai-devbox/` (root only): `claude.env` (Claude token), `ntfy.env` (notification topic).
