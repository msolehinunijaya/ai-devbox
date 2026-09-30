# How a job flows

A job goes from a prompt to a pushed branch through nine stages.

- **Server** is the devbox's own code (`lib/`), with no AI involved.
- **AI** is a headless `claude -p` call.
- **You** means the step waits for you.

```mermaid
flowchart TD
  start([You send a prompt<br/>dashboard or ai start]) --> queue[Queue<br/>max 2 jobs, 1 per project, 400 MB free]
  queue --> setup[1 Setup<br/>worktree, deps, .env]
  setup --> plan[2 Plan<br/>Opus, read-only]
  plan --> review[3 Review<br/>Opus, read-only]
  review --> gate{approve_plan?}
  gate -- yes --> approve[4 Approve<br/>you: approve / edit / reject]
  gate -- no --> execute
  approve -- approved --> execute[5 Execute<br/>Sonnet, per task + check]
  approve -- rejected --> cancelled([Cancelled])
  execute --> preview[6 Preview<br/>DB, seed, build, sslip URL]
  preview --> test[7 Test<br/>tests + screenshots]
  test --> verify[8 Verify<br/>Opus, can fix]
  verify -- committed fixes, round < 3 --> preview
  verify -- pass / partial --> publish[9 Publish<br/>push ai/job branch]
  publish --> done([Done<br/>ntfy, report, you merge])

  execute -. check fails twice .-> needs([Needs you])
  verify -. verdict fail .-> needs
  publish -. push fails .-> needs
  plan -. Claude error / usage limit .-> needs
  review -. Claude error .-> needs
  setup -. command error .-> failed([Failed])
  needs -- Retry / retry --from / take over --> execute

  classDef ai fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef you fill:#FAEEDA,stroke:#854F0B,color:#412402
  classDef stop fill:#FCEBEB,stroke:#A32D2D,color:#501313
  class plan,review,execute,verify ai
  class start,approve,gate you
  class needs,failed,cancelled stop
```

The "Retry" arrow is simplified. A retry resumes whichever stage stopped, and `retry --from <stage>` reruns from any stage.

## Stages

### Start: you send a prompt
| | |
|---|---|
| **You** | Pick a project and write what you want at `http://claude-dev/`, or run `ai start <project> "..."`. |
| **Server** | Creates a job ID and the branch `ai/<job>`, then adds the job to the queue. |
| **If it goes wrong** | Disabled projects (`"enabled": false`) aren't offered. The dashboard is reachable only over Tailscale. |

### Queue
| | |
|---|---|
| **Server** | Checks the queue every 5 s. At most 2 jobs run at once, one per project. A second job starts only when at least 400 MB of memory is available. |
| **AI** | Not involved. |
| **If it goes wrong** | Shows "Waiting for memory" until there's room. If a runner never started, its slot is freed after 60 s. |

### 1. Setup (server)
| | |
|---|---|
| **Server** | Fetches the repo and creates a git worktree on the job branch. Reuses cached `vendor` and `node_modules` when the lock files match, and installs otherwise. Copies `.env` from `.env.example`, generates the app key, and runs the project's `setup` commands (e.g. `wayfinder:generate`). |
| **AI** | Not involved. |
| **If it goes wrong** | A failing command marks the job **failed**, with its output. Fix the cause, then Retry. |

### 2. Plan (Claude Opus, read-only)
| | |
|---|---|
| **AI** | Reads the code with Read, Glob and Grep only; it can't edit or run anything. It returns a plan with a summary, tasks with time estimates, a `verify_cmd` for each task, and pages to screenshot. It follows `prompts/ui-standard.md` and the project's `ui` notes. |
| **Server** | Enforces the JSON schema (`prompts/plan.schema.json`) and turns the tasks into a checklist and an ETA. Time limit: 20 min. |
| **If it goes wrong** | A Claude error or timeout sends the job to **needs you**. If the usage limit is reached, the job goes to **needs you** with "Retry after the limit resets". |

### 3. Review (Claude Opus, second session, read-only)
| | |
|---|---|
| **AI** | A fresh session checks the plan against your request and the code. It approves the plan, or writes a corrected one and lists the issues. |
| **Server** | If the plan was corrected, keeps the original as `plan.original.json` and uses the new one. Time limit: 15 min. |
| **If it goes wrong** | If the reviewer raises issues but sends no new plan, the issues are logged and the original plan is used. A Claude error sends the job to **needs you**. |

### 4. Approve (you, only when the project sets `approve_plan`)
| | |
|---|---|
| **You** | ntfy sends a push to your phone and the job pauses (**awaiting approval**). You can approve, edit the plan and then approve, or reject, which cancels the job. |
| **Server** | Records who approved, using your Tailscale identity. Projects without the gate skip this stage, so the AI review is the only check. |
| **If it goes wrong** | It just waits; nothing runs and no tokens are used. |

### 5. Execute (Claude Sonnet, can edit and run)
| | |
|---|---|
| **AI** | A new session for each task writes code, runs commands and commits. The deny list in `config/claude-settings.json` blocks `git push`, `sudo`, `su`, `gh`, `glab`, `~/.ssh` and `/etc/ai-devbox`. |
| **Server** | Runs the task's `verify_cmd` after each task and commits anything the AI left uncommitted. Tasks already done are skipped on a retry. |
| **If it goes wrong** | If the check fails, the same session is resumed once with the error output. If the check still fails, the job goes to **needs you**. |

### 6. Preview (server)
| | |
|---|---|
| **Server** | Creates the database `ai_<job>`, runs `migrate:fresh --seed`, and creates a preview user with a random password. Builds the frontend, using a cache when the frontend is unchanged from the base commit. Serves the site at `http://<job>.100-103-68-10.sslip.io/` (Tailscale only) and checks it with curl. |
| **AI** | Not involved. |
| **If it goes wrong** | The job doesn't stop. Problems are saved as notes for the verifier to judge. |

### 7. Test (server)
| | |
|---|---|
| **Server** | Runs the project's `tests` (e.g. `php artisan test`, `npm run types:check`). Playwright takes desktop and phone screenshots of up to 6 pages, signing in as the preview user where needed. |
| **AI** | Not involved. |
| **If it goes wrong** | Failing tests don't stop the job; the results go to the verifier. Pages that need a login are skipped when the project has no `preview_login`. |

### 8. Verify (Claude Opus, can fix)
| | |
|---|---|
| **AI** | Gets the diff, commits, test output, preview notes and screenshots. Judges the result as a user would and gives each task **pass**, **partial** or **fail**. May fix problems and commit the fixes. |
| **Server** | Writes `report.md` with the verdict, each task, follow-ups, the preview login and a token table. Time limit: 30 min per round. |
| **Loop** | If the verifier committed fixes, the server rebuilds the preview, reruns the tests and verifies again. It runs at most 3 rounds, and in the last round the verifier only reports. |
| **If it goes wrong** | A **fail** verdict sends the job to **needs you**. A **partial** verdict continues, with the gaps noted in the report. |

### 9. Publish (server)
| | |
|---|---|
| **Server** | Pushes `ai/<job>` to the remote using the deploy key. It never pushes to main, and the AI itself can never push. |
| **AI** | Not involved. |
| **If it goes wrong** | If `push` is off for the project, this stage is skipped and the branch stays on the server. If the push fails, the job goes to **needs you**. |

### End: done
| | |
|---|---|
| **Server** | Sends an ntfy push, stops any leftover processes in the worktree, and starts the next queued job. After 7 days, cleanup removes the worktree and database; the branch is kept. |
| **You** | Open the preview, screenshots and report. Merge the branch on GitHub when you're happy with it. |

## When a job stops

| State | Why | Your options |
|---|---|---|
| Awaiting approval | The project requires plan approval | Approve, edit then approve, or reject |
| Needs you | A task check still fails after the retry, the verdict is fail, the push failed, or a Claude error | **Retry** resumes that stage. `ai retry <job> --from <stage>` reruns from any stage. **Take over** with `sudo -u ai -i tmux attach -t <job>`, fix it by hand, then Retry. |
| Usage limit | The 5-hour Claude window is used up | Wait for it to reset, then Retry |
| Failed | A server command errored (setup, git, etc.) | Read the log, fix the cause, then Retry |
| Interrupted | Reboot, crash or out of memory | Retry resumes the current stage; finished tasks are kept |
| Cancelled | You pressed Cancel or rejected the plan | Retry, or discard it (removes the worktree and database) |

## Always-on safety

- Everything runs as the user `ai`, with no sudo and access only to `ai_*` databases.
- The dashboard and previews are reachable only over Tailscale.
- Heavy steps (install, build, tests, browser) take a shared lock so only one runs at a time, at low CPU and disk priority.
- earlyoom never kills the dashboard or a job runner.
- Dev servers the AI started are stopped when the job ends.
- Every Claude call's tokens are counted per stage and model (`ai tokens`).
