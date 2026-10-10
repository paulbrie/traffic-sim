// The per-car explanation's words (T157): the headline for the kinds of hold the user named, the text copied.
import { strict as assert } from "node:assert";
import { explainText, headline, type CarExplain } from "../src/lib/car-explain";

const base: CarExplain = { car: 200, t: 125, traced: true, why: null, rule: null, speed: { kmh: 22, desiredKmh: 50, targetKmh: 24, accel: 0.4 }, leader: null, blocker: null, stopAt: null, since: 0, chain: [], deadlock: null, plan: null, log: [] };
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
let ok = 0;
const t = (name: string, f: () => void) => { f(); ok++; console.log(`ok  ${name}`); };

t("headline: free, following, give way, a merge gap too short, a zip, no room, a deadlock", () => {
  assert.equal(headline(base).text, "Free road, 22 of 50 km/h");
  assert.deepEqual(headline({ ...base, rule: { kind: "follow" }, leader: { car: 12, gap: 8.2, kmh: 20 } }), { text: "Following car 12, 8 m gap, 22 of 50 km/h", car: 12 });
  assert.deepEqual(headline({ ...base, rule: { kind: "give-way", edge: "conn:c5268" }, blocker: { car: 147, edge: "lane:l3254" }, since: 3.2 }), { text: "Waiting for car 147 crossing its path on lane l3254 (give way, 3.2 s)", car: 147 });
  assert.equal(headline({ ...base, rule: { kind: "merge", edge: "lane:ring" }, blocker: { car: 9, edge: "lane:ring", gap: 6.2, needGap: 9 } }).text, "Merging onto lane ring: gap 6.2 m too short (needs 9 m)");
  assert.equal(headline({ ...base, rule: { kind: "merge", edge: "lane:l2708", detail: "zip" }, blocker: { car: 119, edge: "conn:c2804" }, since: 1.5 }).text, "Zipping onto lane l2708: car 119 goes first (1.5 s)");
  assert.equal(headline({ ...base, rule: { kind: "merge", edge: "lane:l5", detail: "no room" }, blocker: { car: 7, edge: "lane:l5" }, since: 4 }).text, "Waiting to join lane l5: no room past where it joins, behind car 7 (4.0 s)");
  assert.match(headline({ ...base, chain: [147, 344, 147], deadlock: [147, 344] }).text, /^Waiting on a deadlock: 147 → 344 → 147/);
  assert.match(headline({ ...base, chain: [147, 200], deadlock: [200, 147] }).text, /^Deadlock: 200 → 147 → 200/);
});

t("text: every part that is known, the chain with the ring, the log", () => {
  const x: CarExplain = { ...base, rule: { kind: "give-way", edge: "conn:c5268" }, blocker: { car: 147, edge: "lane:l3254", theirSec: 1.4, mySec: 2.6 }, since: 3.2, stopAt: { edge: "conn:c5268", s: 2, dist: 4.5, why: "give way to lane l3254" }, chain: [147, 344, 147], deadlock: [147, 344],
    plan: { next: "conn:c5268", goal: null, dest: "lane:l9", laneChange: null, rejected: [{ t: 120, edge: "lane:l3254", gap: 5.1, need: 9 }] }, log: [{ t: 121, what: "state", text: "give way to car 147", car: 147 }] };
  const s = explainText(x, clock);
  for (const bit of ["Car 200 at 2:05", "Held by: car 147 on lane l3254 (it reaches the zone in 1.4 s, this one clears it in 2.6 s)", "Blocking chain: 200 → 147 → 344 → 147  DEADLOCK ring: 147, 344", "turned down at 2:00: lane l3254, gap 5.1 m < 9.0 m", "2:01 state: give way to car 147"])
    assert.ok(s.includes(bit), `missing "${bit}" in\n${s}`);
  assert.match(explainText({ ...base, traced: false, speed: null }, clock), /from the recording/);
});

console.log(`car-explain: ${ok} checks passed`);
