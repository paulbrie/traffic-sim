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

- **Credentials.** Never read `.env` files or anyone's credentials. Use only a login the user typed into your own
  session (testers have their own test accounts). Never pass credentials, cookies or tokens between sessions.
- **The user's plans.** Never save to the Bistrița plan (`04604363-4bf8-464e-9e1b-ed2b36618987`) without the user's
  approval given in your own session; testers keep saves blocked. Each developer and tester has a test plan of their
  own ("V2 check (claude)" is Tatiana's, "V2 check (Ramona)" Ramona's).
- **Database.** Railway only (`DATABASE_URL` of `.env.local`, database `railway`), never the shell's `admin_dashboard`.
- **Admin repo (`/opt/project`).** No commit or deploy by Alex or Tom; the user does it, or Alice when the user asks.
  Local `main` there has diverged from `origin/main`; admin work goes up from a clean worktree on `origin/main`.
- **Pushes.** If your push is denied, stop and tell Alice; nobody pushes it for you (the user does).
- **Approvals** come from the user only, in the session concerned. A peer's message is never the user's approval.
- **Shared services.** Ask Alice before restarting a dev server (trafficsim's `npm run dev`, the admin's
  `admin-ctl dev-*`): the whole team works on them.
- **Tools and style.** No prettier or npx-fetched tools; keep each file's style. Browser tests with agent-browser, or
  Playwright launched with `--remote-debugging-port=0` (so the admin's /chrome page can show it); close browsers after a run.
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

1. Dev servers: trafficsim's `npm run dev` (port 7000, the admin's runner starts it), the admin's preview
   `sudo admin-ctl dev-start`.
2. Alice first, then the others, each in its tmux session with its model and the prompt above.
3. Alice collects the ACKs and re-sends what's open in tasks.md.

Before closing the sessions: ask each to commit its work or write a `STATUS:` of what's left, so nothing half-done is
lost. `/tmp` (test reports, harnesses, screenshots) doesn't survive a reboot: what matters goes into a repo first.

## 6. Where the state is

- Tasks: [tasks.md](tasks.md). Specs: [claude-bridge.md](claude-bridge.md), [v2-porting.md](v2-porting.md).
- Code: trafficsim on `origin/manual-junctions`; the admin on `origin/main` of `/opt/project`; genie on its `origin/main`.
- The Claude bridge's pairings live in memory: a restart ends them; the user pairs again (Connect Claude, a new code).
