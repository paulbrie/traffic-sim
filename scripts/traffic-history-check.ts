/**
 * TomTom's traffic recorded over time (ticket #261), without the network or the database:
 * - waysOf: a two-way road split in its two directions (headings by compass, y south), a one-way road one way, bike lanes left out;
 * - wayTuple: a way's lanes combined, weighted by the length each covers; none covered: null;
 * - historyExport: samples in time order, 5-minute slots and weekdays (UTC), incidents once each with when first and last
 *   seen, the network's share covered, a failed sample's error; the summary's slowest ways and slots;
 * - historyCsv: one row per sample and way, names with commas quoted.
 * npm run traffic-history:check
 */
import type { Sketch } from "../src/lib/lane-sketch";
import { historyCsv, historyExport, waysOf, wayTuple, type LaneTuple, type StoredSample } from "../src/lib/traffic-history";
import type { Incident } from "../src/lib/tomtom-api";

let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };

// (a two-way road along x, 200 m, two lanes east and one west; a one-way street north, 100 m; a bike lane on the first)
const line = (x0: number, y0: number, x1: number, y1: number) => ({ kind: "line" as const, pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] });
const sk: Sketch = {
  lanes: [
    { id: "e1", width: 3.5, shape: line(0, 1.75, 200, 1.75) },
    { id: "e2", width: 3.5, shape: line(0, 5.25, 200, 5.25) },
    { id: "w1", width: 3.5, shape: line(200, -1.75, 0, -1.75) },
    { id: "n1", width: 3.5, shape: line(300, 0, 300, -100) },
    { id: "b1", width: 2, bike: true, shape: line(0, 8, 200, 8) },
  ],
  connectors: [], junctions: [],
  roads: [{ id: "r1", name: "Main, Street", lanes: ["e1", "e2", "w1", "b1"], speed: 50 }, { id: "r2", name: "", lanes: ["n1"] }],
  traffic: { rate: 10, speed: 30 },
  geo: { lat: 47, lon: 24 },
};

const ways = waysOf(sk);
ok(ways.length === 3, `three ways: the road's two directions and the one-way street (${ways.map(w => w.id).join(" ")})`);
const [a, b, n] = ways;
ok(a.id === "r1/a" && a.lanes.join() === "e1,e2" && a.heading === "E" && a.bearing === 90 && a.laneCount === 2 && a.lengthM === 200, "r1/a: east, its two lanes (not the bike lane), 200 m");
ok(b.id === "r1/b" && b.lanes.join() === "w1" && b.heading === "W" && b.bearing === 270, "r1/b: west");
ok(n.id === "r2/a" && n.heading === "N" && n.bearing === 0 && n.name === "r2" && n.limitKmh === 30 && a.limitKmh === 50, "r2/a: north (y south), no name: its id, the sketch's speed limit; r1's own");

const lengths = new Map(sk.lanes.map(l => [l.id, 200]));
const t = wayTuple(a, { e1: [20, 0.4, 50, 1, 0], e2: [40, 0.8, 50, 0.5, 0] }, lengths)!;
// (e1 counts 200 m, e2 100 m: (20·200 + 40·100) / 300)
ok(Math.abs(t[0]! - 26.7) < 1e-9 && Math.abs(t[1]! - 0.53) < 1e-9 && t[2] === 50 && t[3] === 0.75 && t[4] === 0, `a way's lanes weighted by the length covered (${t.join(", ")})`);
ok(wayTuple(b, { e1: [20, 0.4, 50, 1, 0] }, lengths) === null, "a way none of whose lanes is covered: null");
ok(wayTuple(a, { e1: [5, 0.1, 50, 1, 1], e2: [40, 0.8, 50, 1, 0] }, lengths)![4] === 0 && wayTuple(a, { e1: [5, 0.1, 50, 1, 1], e2: [0, 0, null, 0.4, 1] }, lengths)![4] === 1, "closed where most of what is covered is");

const inc = (id: string): Incident => ({ id, iconCategory: 6, magnitudeOfDelay: 2, delay: 90, from: "A", to: "B", description: "Queuing traffic", coordinates: [{ lat: 47.123456789, lon: 24.1 }] });
const area = { south: 0, west: 0, north: 1, east: 1 };
const sample = (at: string, lanes: Record<string, LaneTuple>, incidents: Incident[] = [], error: string | null = null): StoredSample => ({ at, revision: 1, area, tiles: 4, lanes, incidents, error });
const rows = [
  sample("2026-11-17T04:05:02Z", { e1: [20, 0.4, 50, 1, 0], w1: [50, 1, 50, 1, 0] }, [inc("j1")]),
  sample("2026-11-17T04:00:01Z", { e1: [30, 0.6, 50, 1, 0], w1: [50, 1, 50, 1, 0] }),
  sample("2026-11-17T04:09:58Z", {}, [], "TomTom's quota for the key is used up for now; try again later."),
  sample("2026-11-18T04:04:40Z", { e1: [10, 0.2, 50, 1, 0], n1: [25, 0.5, 50, 1, 0] }, [inc("j1"), inc("j2")]),
];
const e = historyExport({ id: "p", name: "Plan", revision: 3 }, sk, rows, new Date("2026-11-20T00:00:00Z"));
ok(e.samples.map(s => s.slot).join() === "04:00,04:05,04:10,04:05" && e.samples[0].weekday === "Tue" && e.samples[3].day === "2026-11-18", "in time order, each at its 5-minute slot (UTC), with its day and weekday");
ok(e.range.samples === 4 && e.range.from === "2026-11-17T04:00:01.000Z" && e.range.to === "2026-11-18T04:04:40.000Z", "the range");
ok(e.samples[2].error?.startsWith("TomTom's quota") === true && !Object.keys(e.samples[2].ways).length && e.samples[0].error === undefined, "a failed sample keeps its error");
ok(Object.keys(e.incidents).join() === "j1,j2" && e.incidents.j1.samples === 2 && e.incidents.j1.firstSeen === "2026-11-17T04:05:02.000Z" && e.incidents.j1.lastSeen === "2026-11-18T04:04:40.000Z" && e.incidents.j1.kind === "jam" && e.incidents.j1.magnitude === "moderate", "incidents once each, first and last seen, kind and magnitude by name");
ok(e.incidents.j1.coordinates[0][0] === 47.12346 && e.samples[3].incidents.join() === "j1,j2", "incident points rounded, each sample's listed");
// (r1/a: e1 covered, e2 not: half its 400 m of lanes; r1/b 200 m covered; of 700 m in all)
ok(e.samples[0].covered === Math.round((400 / 700) * 100) / 100 && e.samples[0].ways["r1/a"][3] === 0.5 && e.samples[0].ways["r1/b"][1] === 1, `the share of the plan covered (${e.samples[0].covered})`);
ok(e.summary.slowestWays[0].way === "r1/a" && e.summary.slowestWays[0].worstSlot === "04:05", "the slowest way first, with its worst slot");
ok(e.summary.bySlot.map(s => s.slot).join() === "04:00,04:05" && e.summary.bySlot[1].samples === 2, "by slot over the days, failed samples left out");
ok(!("lanes" in e.ways[0]) && e.columns.join() === "kmh,rel,free,cover,closed" && e.plan.origin?.lat === 47, "ways without their lanes, the columns named, the plan's place");

const csv = historyCsv(e).trim().split("\n");
ok(csv[0] === "at,day,weekday,slot,way,road,name,heading,length_m,limit_kmh,kmh,rel,free,cover,closed", "the CSV's header");
ok(csv.length === 1 + 2 + 2 + 0 + 2 && csv[1].includes(',"Main, Street",E,200,50,30,0.6,50,0.5,0'), `one row per sample and way covered, a name with a comma quoted (${csv[1]})`);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
