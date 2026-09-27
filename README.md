# Gridlock — street design & traffic simulation

Design street networks precisely (lanes, curves, junction control, bus lanes and lines),
then run a deterministic traffic simulation on them in a plan view or in 3D.
Plans are grouped by city and stored in Postgres.

Stack: Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · shadcn/ui components ·
[subjecto](https://github.com/paulbrie/subjecto) for client state · Drizzle ORM · Postgres 16 · three.js.

## Run it

```bash
npm install
cp .env.example .env          # DATABASE_URL for the Docker database below
npm run db:up                 # docker compose: Postgres 16 on localhost:5544
npm run db:migrate            # create tables
npm run db:seed               # optional: "Demo City" with a sample plan and a blank plan
npm run dev                   # http://localhost:3000
```

`npm run db:admin` creates the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (in `.env.local` or `.env`;
a password is generated and printed if `ADMIN_PASSWORD` is empty). That account must pick a new password at first sign-in.

`npm run db:setup` does the database steps in one go. If the app shows "Can't reach the database"
or "needs migrating", it tells you which of these steps is missing. After pulling changes that add a
migration (for example the reference image support), run `npm run db:migrate` again.

Using your own Postgres instead of Docker: point `DATABASE_URL` in `.env` at it and skip `db:up`.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run db:studio` (Drizzle Studio),
`npm run db:generate` (after changing `src/db/schema.ts`), `npm run engine:check` (headless simulation run).

## Using the editor

| Key | Tool / action |
| --- | --- |
| `V` | Select: click roads, junctions, stops, vehicles; drag junctions; drag the square handle to curve a road, then the two round handles to shape it |
| `R` → `C` | Draw roads with smooth curves: every point you click becomes a bend the road flows through (toggle Straight/Curved in the bar) |
| `R` | Draw roads: click to place points, click an existing road to join it (creates a junction), `Esc`/double-click to finish, `Shift` for 15° angles |
| `B` | Bus stop: click the side of a road where buses should stop |
| double-click a road | Add a bend point (Select tool); drag it, then **Smooth here** / **Sharp corner** in the inspector, or **Smooth whole road** on a road |
| Make junction here | On a road point (double-click a road to add one), turns it into a junction: traffic lights (with an all-red crossing phase), stop or priority |
| `I` | Reference image: drag it to move, corners to scale, round handle to rotate (`Shift` for 15°) |
| `H` / `Space`+drag | Pan · scroll or two-finger drag pans, `⌘`/`Ctrl`+scroll zooms |
| `P` | Run / pause traffic · `F` fit · `+`/`-` zoom |
| `⌘Z` / `⇧⌘Z` | Undo / redo · `Delete` removes the selection |

Reference image: in the **Image** tab, drop a map screenshot, aerial photo or site drawing (PNG/JPEG/WebP, up to 25 MB).
Use **Calibrate scale** (click two points whose real distance you know, type the distance), then rotate and move it
into place, lock it, and trace your streets over it. It is stored per plan (`plan_images` table), can be shown on
the 3D ground, and is copied when you duplicate a plan.

Precision: the inspector takes exact coordinates for junctions, length and bearing for straight roads,
and exact curve handle positions. Grid snapping is adjustable from 0.5 m to 20 m.

Roads: 0–4 lanes per direction (0 = one-way), optional bus-only kerb lane per direction, speed limit.
Junctions (3+ roads): priority (first come, first served), all-way stop, actuated traffic lights
(green / yellow / all-red / minimum green per junction), or roundabout. Dead ends are entry/exit points
where traffic comes from and leaves to the rest of the city (toggle to make them turn-arounds).

Changes save automatically. If the same plan was saved from another tab, you choose whose version to keep.
Duplicate a plan from the city page to compare alternatives.

## Code map

- `src/engine/` — headless, deterministic simulator (no React, no DOM)
  - `types.ts` plan data model (what is stored as JSON in `plans.network`)
  - `compile.ts` turns nodes + links into lanes, junction areas, turn movements with lane rules, connectors, signal phases, roundabout rings
  - `sim.ts` vehicles (cars, trucks, buses), IDM car-following, MOBIL-style lane changes, junction reservations with conflict checks, roundabout gap acceptance, A* routing with congestion
  - `validate.ts` sanitises plan JSON on the server
- `src/state/` — subjecto stores (`ui` DeepSubject, `network$`/`settings$`/`stats$` Subjects), undo history, edit operations, simulation controller
- `src/render/` — shared road geometry, Canvas 2D renderer, three.js scene builders
- `src/components/workspace/` — editor UI: canvas, 3D view, inspector, traffic and bus-line panels
- `src/server/` — queries and server actions (Drizzle) · `src/db/` schema and client · `drizzle/` migrations

This app has no authentication; it is meant to run locally.

## Users

Everyone signs in (`/login`). Two roles:

- **admin**: everything, plus **Manage users** in the account menu (`/admin/users`): add users (a temporary password is
  shown once), change roles, reset passwords, delete users. You can't demote or delete yourself, and the last admin can't be deleted.
- **user**: create and edit cities and plans.

Passwords are hashed with scrypt; sessions are random tokens in an httpOnly cookie, stored hashed in `sessions` (30 days).
Scripts read `.env.local` first, then `.env`, like Next does.
