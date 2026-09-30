---
name: devbox
description: Run and manage AI Devbox jobs from a Claude Code session on this server. Start a job on a project, check status, read plans, reports and logs, approve, retry, cancel, take over, and see token usage. Use when the user types /devbox or asks to start, check, approve or retry a devbox job.
argument-hint: "[start <project> <prompt> | status | <job> | plan | approve | retry | report | log | tokens | cancel | takeover | projects]"
allowed-tools: Bash(./ai *), Bash(/var/www/ai-devbox/ai *), Read
---

# /devbox

Drive the AI Devbox job queue through its CLI, `/var/www/ai-devbox/ai`. The dashboard (`http://claude-dev/`) uses the same queue and runner, so a job started here shows up there and the reverse.

Arguments: `$ARGUMENTS`

## Rules

- Always run the CLI as `/var/www/ai-devbox/ai <command>`. It must run as root (it loads the Claude token and switches to the `ai` user itself). Never run `node cli.js` directly, and never `sudo -u ai` it yourself.
- Never edit files in `run/`, a job's worktree or `config/` to change a job. Use the CLI.
- Never use `status --watch`; it doesn't exit. Use `status <job>` and run it again if the user wants an update.
- **Job IDs:** they are long (`test-add-simple-task-list-at-0929-1818`). If the user gives part of one (e.g. "task list" or "the last test job"), run `ai list` and pick the match. If several match, ask which one. "Last" or "latest" means the newest by the time at the end of the ID.
- **Ask before destructive commands.** Before `cancel`, `reject`, `discard`, or `cleanup` without `--dry-run`, say what will happen and wait for a yes.
  - `discard` deletes the branch.
  - `cancel` stops a running job.
- **Approvals:** for `approve`, pass `--by "$(git config user.name) via Claude Code"` so the record shows who approved and from where.

## What to do for each argument

- **No arguments or `status`:** run `ai list`, then summarise:
  - what is running or queued now
  - anything waiting for the user (**awaiting_approval** or **needs_you**, with the job's message from `ai status <job>`)
  - the last few finished jobs

  End with the one next action if there is one (e.g. "test-… is waiting for your approval").
- **`start <project> <prompt…>`:** check the project exists (`ai projects`), then `ai start <project> "<prompt>"`. Report the job ID, its preview URL pattern (`http://<job>.100-103-68-10.sslip.io/`), and that ntfy will send a push when it needs the user or finishes. If the prompt is vague, say so briefly but still start it unless the user asked for help writing it.
- **A job ID or name alone:** run `ai status <job>`. If the job is **needs_you** or **failed**, also run `ai log <job> -n 80` and explain in plain words why it stopped and which fix you suggest (Retry, `retry --from <stage>`, or take over).
- **`plan <job>`:** run `ai plan <job>` and summarise the tasks and the reviewer's notes. If the job is waiting for approval, ask whether to approve, reject or change it. To change it:
  1. Edit `run/jobs/<job>/plan.json` (the only file edit allowed).
  2. Keep it valid against `prompts/plan.schema.json`.
  3. Then approve.
- **`approve <job>`:** run `ai approve <job> --by "…"`.
- **`reject <job>`:** ask first, then run `ai reject <job>`.
- **`retry <job> [--from <stage>]`:** the stages are setup, plan, review, approve, execute, preview, test, verify and publish. With no `--from`, the job resumes the stage that stopped. Pick `--from` only when the user asks or the log shows an earlier stage needs redoing (e.g. `--from preview` after a fix to seed data).
- **`report <job>`:** run `ai report <job>` and give the verdict, what passed, what didn't and the follow-ups. Mention the preview URL and sign-in if the report has them.
- **`log <job>`:** run `ai log <job> -n 80` (more with a larger `-n` if asked) and explain what it shows. Don't paste the whole log back.
- **`tokens [job]`:** run `ai tokens [job]` and give the totals, plus the costliest stage or job.
- **`cancel <job>`, `discard <job>`, `archive <job>`:** confirm first for cancel and discard, then run the command.
- **`takeover <job>`:** run `ai takeover <job>`. You can't attach to tmux from here, so give the user the printed `sudo -u ai -i tmux attach -t <job>` command in a `bash` block. Tell them to run it in the Terminal panel, detach with Ctrl+B then D, and then `/devbox retry <job>`.
- **`projects`:** run `ai projects`.
- **Anything else in plain words** (e.g. "why did the last job fail"): work out the matching commands from above and run them.

## How a job works

See `docs/FLOW.md` for the nine stages, what the AI does in each, and the fallbacks. Use it to explain a stopped job.
