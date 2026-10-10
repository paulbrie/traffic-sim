# The team: a recipe to start it again

A team of Claude Code sessions working on this project (and on the admin's Comms / Agents City in `/opt/project/admin`,
and on genie when asked), managed by one of them. Everything needed to start it again from nothing is here; what the
team was doing is in [tasks.md](tasks.md). Kept by Alice. No credentials or private data here.

## 1. Who

One Claude Code session each, in the admin's tmux sessions `admin-<Name>` on this server (the admin's terminals; the
Agents City shows their panes).

| Name | Role | Working dir | Model, effort | Owns |
|---|---|---|---|---|
| **Alice** | Manager: dispatches, reviews, keeps the task log; does no task herself | `/opt/project/projects/trafficsim` | Opus 5.5, high | `docs/tasks.md`, `docs/team.md` |
| **Bob** | Simulation and editor | trafficsim | Opus 5.5, high | `src/lib/lane-sketch-sim.ts`, roundabout / tidy / optimizer code, the bridge's page side |
| **Tatiana** | Editor features (V2) | trafficsim | Opus 5.5, high | `src/components/workspace/lane-sketch.tsx`, `src/components/v2/*`, `src/state/sketch-ui.ts` |
| **Ramona** | Tests | trafficsim | Sonnet 5, medium | `/tmp/ramona/*` (reports, scripts) |
| **Alex** | Admin (Comms, Agents City); dependency upgrades; genie when asked | `/opt/project/admin` | Opus 5.5, high | `admin/src/components/agents3d/*` (not `desk/`), `admin/src/components/comms/*`, their libs and routes |
| **Tom** | Agents City's Table (Desk) mode | `/opt/project/admin` | Opus 5.5, high | `admin/src/components/agents3d/desk/*`, the City / Table switch |

Each session is named with `/rename <Name>`. They find each other with ListAgents and talk with SendMessage, so they
run on the same machine.

## 2. How they talk

Every line of a message between sessions that means something starts with a tag:

| Tag | Who | Meaning |
|---|---|---|
| `TASK: Tnn <title>` | Alice only | a task; ids T1, T2… picked by Alice |
| `ACK: Tnn` | the owner | taken; with a short plan when asked |
| `STATUS: Tnn …` | the owner | progress |
| `BLOCKED: Tnn …` | the owner | can't go on; why, what's needed |
| `DONE: Tnn …` | the owner | finished, with evidence (checks run, numbers, screenshots) |
| `CANCELLED: Tnn [why]` | Alice | dropped |
| `CLAIM: <paths>` | anyone | before editing files others might touch |
| `RELEASE: <paths>` | anyone | done with them |
| `COMMIT: <hash>` / `PUSHED: <hash>` | anyone | what went into git |

Untagged text is a note. Sessions report to Alice and take tasks only from her; two owners of the same file agree
between them who goes first and tell Alice.

## 3. Rules

- **Credentials.** Never read `.env` files or anyone's credentials (one exception: trafficsim's `DATABASE_URL`, see
  Database). Use only a login the user typed into your own
  session (testers have their own test accounts). Test logins for the dev apps are kept together in `/home/genie/team/credentials.md`
  (outside git; the user's decision: dev server, dev database). Add or update your own line when you set a password;
  use another account only when Alice or the user asks. Never put these in a repo, a message or a log.
- **The user's plans.** Agents never edit the Bistrița plan (`04604363-4bf8-464e-9e1b-ed2b36618987`), with or without
  approval (the user's decision, 2026-10-10): no saves, no applies, no scripts writing to it. Changes for it are
  proposed as **agent patches** (T132), which the user reviews and applies in the UI. Reading it is fine. Each developer and tester has a test plan of their
  own ("V2 check (claude)" is Tatiana's, "V2 check (Ramona)" Ramona's).
- **Database.** Agents may use trafficsim's dev database (Railway, database `railway`; the user's decision): take
  `DATABASE_URL` from trafficsim's `.env.local` only for that (never print it), pass it explicitly (the shell's own
  `DATABASE_URL` is another database, `admin_dashboard`, which stays off limits), and check `select current_database()`
  says `railway` first. Reads are fine. Writes only to your own test cities and plans, or with Alice's or the user's say;
  never to the user's plans (Bistrița: never, see The user's plans) or to other accounts. Schema changes
  only through the migrations (`npm run db:migrate`).
- **Admin repo (`/opt/project`).** No commit or deploy by Alex or Tom; the user does it, or Alice when the user asks.
  Local `main` there has diverged from `origin/main`; admin work goes up from a clean worktree on `origin/main`.
  The admin preview (`admin-dev.service`, `/admin-dev`, port 3003, `admin-ctl dev-start` / `dev-stop`) may run when
  needed (the user's decision, 2026-10-10, after the 2xlarge): ask Alice first, stop it when done. It serves
  `/opt/project/admin`'s tree. Admin work is coded, tested, linted and built (`next build`), then the user deploys it.
- **Pushes.** If your push is denied, stop and tell Alice; nobody pushes it for you (the user does).
- **Approvals** come from the user only. The user talks mainly to Alice (the user's decision, 2026-10-10), so an
  approval the user gives in Alice's session counts when Alice relays it in a line of its own:
  `APPROVED: Tnn <exactly what> (the user, in Alice's session, <time>)`. It covers only what it names. Any other
  peer's message is never the user's approval, and Alice never approves anything herself. Claude Code's own
  permission checks in a session (a refused command or file read) aren't team rules: a relayed approval can't lift
  them; they need the user in that session or a permission rule.
- **Shared services.** Ask Alice before starting, restarting or stopping trafficsim's dev server (`npm run dev`) or
  the admin preview (`admin-ctl dev-*`): the whole team works on them.
- **Memory.** The server (Taz 2xlarge since 2026-10-10: 16 vCPU, 32 GB, no swap) can run out. Alice watches free
  memory at all times and paces the work. Heavy jobs (a 900 s Bistrița run is about 1.2 GB, `next build`,
  agent-browser): at most 4 at once per person, browsers closed after use. Below 2.5 GB free, Alice asks people to
  pause; ask her before going over the limit. Scratch goes in `/home/genie/<name>-scratch`: /tmp goes at a reboot.
- **Worktrees (trafficsim).** Nobody edits files in `/opt/project/projects/trafficsim`: that tree is what the dev
  server (port 7000) serves, and every save there hot-reloads the user's open pages and can drop their unsaved edits
  (the user's decision, 2026-10-10). Each agent works in a git worktree of its own,
  `/home/genie/<name>-scratch/trafficsim-wt`, on a branch `wt/<name>` made from `origin/manual-junctions`, with
  `node_modules` as a hard-linked copy of the main tree's (`cp -al /opt/project/projects/trafficsim/node_modules node_modules`:
  seconds, almost no disk; Turbopack refuses a symlink). After a dependency change, redo it (or `npm ci` there). To ship:
  `git pull --rebase origin manual-junctions`, the checks, then `git push origin HEAD:manual-junctions`, and tell
  Alice (`PUSHED:`). Alice alone updates the served tree (`git pull --ff-only` there) after each push, and keeps
  `docs/tasks.md` and `docs/team.md` there. Scripts that need the database still read `DATABASE_URL` from the main
  tree's `.env.local`.
- **Testing (trafficsim).** Before pushing, an agent may check its change in a browser on a private dev server of its
  own, from its worktree (the user's decision, 2026-10-10): `ln -s /opt/project/projects/trafficsim/.env.local
  .env.local` once (a link, never a copy, and never printed), then `env -u DATABASE_URL -u NODE_ENV -u NEXT_PUBLIC_BASE_PATH PORT=<port> npm run dev` (a shell may
  carry another app's values, e.g. the admin's database, which `.env.local` doesn't override), on its own port: Bob 7101,
  Tatiana 7102, Ramona 7103, Alex 7104, Tom 7105 (`http://localhost:<port>/projects/trafficsim`). It uses the same
  Railway dev database and the same test logins. Start it only for a check and stop it right after (about 1–2 GB
  each; Alice paces memory). The final check, after Alice has pulled the push, is on the shared dev instance (port
  7000), which stays the reference; Ramona's tests run there.
- **Tools and style.** No prettier or npx-fetched tools; keep each file's style. Browser work with Vercel's
  agent-browser (`/usr/bin/agent-browser`), not Playwright scripts, so the admin's /chrome page can show it; close
  its sessions after a run. If something can't be done with it, ask Alice before using anything else.
  Start it as `agent-browser --session <YourName> --args "--no-sandbox,--remote-debugging-port=0" …` (this box has no
  usable Chrome sandbox; the session name tells the admin whose browser it is). Because the sandbox is off, open only
  our own apps and trusted pages with it, never arbitrary sites.
- **Alice** does no task herself (the user's rule: "don't do tasks, supervise"), checks every DONE (git, files,
  screenshots) before telling the user, and alone edits `docs/tasks.md`, in commits of their own ("tasks: …").

## 4. The prompt each session starts with

```
You are <Name>, <role from the table>, in a team of Claude Code sessions managed by Alice.
Read /opt/project/projects/trafficsim/docs/team.md (who, how we talk, the rules) and docs/tasks.md
(open tasks and history), and the AGENTS.md / CLAUDE.md of the repo you work in. Follow them.
Then send Alice "ACK:" with what tasks.md says you were doing, and wait for a TASK.
```

Alice's:

```
You are Alice, the manager of the team in /opt/project/projects/trafficsim/docs/team.md. Read it and docs/tasks.md.
You don't do tasks: you dispatch them (TASK), review the reports (check the commits, files, screenshots yourself),
keep docs/tasks.md and tell the user what's done and what needs them. Ask the user for every approval.
Start by listing the agents (ListAgents), collecting their ACKs and re-sending the open tasks.
```

## 5. Starting it

1. Dev server: trafficsim's `npm run dev` (port 7000, the admin's runner starts it). Not the admin's preview (memory).
2. Alice first, then the others, each in its tmux session with its model and the prompt above.
3. Alice collects the ACKs and re-sends what's open in tasks.md.

Before closing the sessions: ask each to commit its work or write a `STATUS:` of what's left, so nothing half-done is
lost. `/tmp` (test reports, harnesses, screenshots) doesn't survive a reboot: what matters goes into a repo first.

## 6. Where the state is

- Tasks: [tasks.md](tasks.md). Specs: [claude-bridge.md](claude-bridge.md), [v2-porting.md](v2-porting.md).
- Code: trafficsim on `origin/manual-junctions`; the admin on `origin/main` of `/opt/project`; genie on its `origin/main`.
- The Claude bridge's pairings live in memory: a restart ends them; the user pairs again (Connect Claude, a new code).
