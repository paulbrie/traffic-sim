# TomTom traffic recorded over time (ticket #261)

TomTom's API gives the traffic **now**. Its past traffic is a separate, paid product (Traffic Stats). So we record it
ourselves. Every 5 minutes in the hours set, `scripts/traffic-collect.ts` fetches what the editor's Live traffic panel
fetches for a plan, over the area its lanes cover:

- the flow tiles: each road's km/h now, as a share of its free-flow speed, and closures;
- the incidents: jams, roadworks, closures, accidents.

It keeps them in `traffic_samples` (Railway): the lines (gzipped, to match them again later), each lane's match on the
plan's sketch then, the incidents, and why a fetch failed, if it did. One sample is about 35 KB, and the plan's 16 tiles
of each kind make 32 tile requests.

## Schedule (cron, UTC on this server)

The plan Bistrița Auto Search v2 (`b87c01a7-40ea-4aa3-a72a-7c917a58091b`), 04:00–07:00 and 14:00–17:00 UTC, every 5
minutes, both ends included (74 samples a day):

```
*/5 4-6,14-16 * * * cd /opt/project/projects/trafficsim && env -u DATABASE_URL -u NODE_ENV /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/traffic-collect.ts b87c01a7-40ea-4aa3-a72a-7c917a58091b >> /home/genie/.local/state/trafficsim-traffic.log 2>&1
0 7,17 * * * cd /opt/project/projects/trafficsim && env -u DATABASE_URL -u NODE_ENV /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/traffic-collect.ts b87c01a7-40ea-4aa3-a72a-7c917a58091b >> /home/genie/.local/state/trafficsim-traffic.log 2>&1
```

(`env -u DATABASE_URL`: the database comes from `.env.local`, Railway. The script checks for `railway` and stops on
anything else.) To record more plans, add their ids to the same command.

## Getting it out

- `npm run traffic:export -- <planId> [--from 2026-11-17] [--to 2026-11-30] [--out dir] [--rematch]` writes
  `traffic-<plan>-<from>-<to>.json` and `.csv`. Pass Railway's `DATABASE_URL` explicitly where the shell has another.
  `--rematch` matches the kept lines on the plan's sketch now. Use it once the plan's lanes have changed since recording.
- In the editor, the Live traffic panel shows how many snapshots there are, with the last 14 days as JSON or CSV
  (`/api/plans/<id>/traffic/history?days=14&format=csv`).

The JSON explains itself (`about`). For each road one way (a "way": road id + `a`/`b`, name, heading, length, speed limit)
and each sample, it gives `[kmh, rel, free, cover, closed]`. It also has the incidents, with when each was first and last
seen. A `summary` comes first: by 5-minute slot, the network's share of free flow and its slowest ways; then the slowest
ways overall. The CSV is the same per-sample table, one row per sample and way, for pandas & co.

To hand it to an agent: export, then give it the JSON (the `about` lines say what everything is) and the plan id. Agents
propose changes as patches (`npm run patch:submit`), not as edits to the plan.
