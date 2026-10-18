// The per-car explanation's words (T157): the headline for the kinds of hold the user named, the text copied.
import { strict as assert } from "node:assert";
import { explainText, headline, noRouteText, patienceNote, type CarExplain } from "../src/lib/car-explain";

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
  for (const bit of ["Car 200 at 2:05", "Held by: car 147 on lane l3254 (1.4 s from the crossing, this one needs 2.6 s)", "Blocking chain: 200 → 147 → 344 → 147  DEADLOCK ring: 147, 344", "turned down at 2:00: lane l3254, gap 5.1 m < 9.0 m", "2:01 state: give way to car 147"])
    assert.ok(s.includes(bit), `missing "${bit}" in\n${s}`);
  assert.match(explainText({ ...base, traced: false, speed: null }, clock), /from the recording/);
});

t("crossing waits with the junction rules' reasons (T161): in words, unknown ones as they come; the patience note", () => {
  const w = (kind: "give-way" | "priority" | "zone", detail?: string) => headline({ ...base, rule: { kind, edge: "conn:c7", ...(detail ? { detail } : {}) }, blocker: { car: 147, edge: "lane:l3254" }, since: 3.2 }).text;
  assert.equal(w("priority", "from the right"), "Waiting for car 147 crossing its path on lane l3254 (it comes from the right, 3.2 s)");
  assert.equal(w("priority", "main road"), "Waiting for car 147 crossing its path on lane l3254 (it's on the main road, 3.2 s)");
  assert.equal(w("priority", "roundabout"), "Waiting for car 147 crossing its path on lane l3254 (the roundabout goes first, 3.2 s)");
  assert.equal(w("give-way", "left turn"), "Waiting for car 147 crossing its path on lane l3254 (you're turning left across it, 3.2 s)");
  assert.equal(w("priority", "already in the zone"), "Waiting for car 147 crossing its path on lane l3254 (already in the crossing, 3.2 s)");
  assert.equal(w("priority", "set off first"), "Waiting for car 147 crossing its path on lane l3254 (it set off first, 3.2 s)");
  assert.equal(w("zone", "first come"), "Waiting for car 147 crossing its path on lane l3254 (first come, first served, 3.2 s)");
  assert.equal(w("zone", "something new"), "Waiting for car 147 crossing its path on lane l3254 (something new, 3.2 s)");
  // (the setting off: no detail but "already in the zone", or none: as before)
  assert.equal(w("zone"), "Waiting for car 147 crossing its path on lane l3254 (first come, first served, 3.2 s)");
  const x = (kind: "give-way" | "zone" | "priority", detail?: string): CarExplain => ({ ...base, rule: { kind, ...(detail ? { detail } : {}) }, blocker: { car: 147, edge: "lane:l3254" }, since: 3.2 });
  assert.equal(patienceNote(x("give-way", "give-way line")), "Patience: 3.2 of 10 s at the give-way; then it goes once car 147 can still stop comfortably.");
  assert.equal(patienceNote(x("zone", "first come")), "Patience: 3.2 of 6 s; then the one waiting longer goes.");
  assert.equal(patienceNote(x("zone", "first come"), 12), "Patience: 3.2 of 12 s; then the one waiting longer goes.", "the plan's own tuning");
  assert.equal(patienceNote(x("priority", "from the right")), null);
  assert.equal(patienceNote(x("zone", "already in the zone")), null);
  assert.match(explainText(x("give-way", "give-way line"), clock), /\nPatience: 3\.2 of 10 s at the give-way/);
});

t("no route (T166): leads the headline when nothing else holds the car (or it only follows one), else said under it; a loop at speed isn't a deadlock", () => {
  const nr = { dest: "lane:l3198", at: "lane:l3251", why: "it is on a loop that no way leaves" };
  const lost = "No way to its destination (lane l3198) from lane l3251: it is on a loop that no way leaves";
  assert.equal(headline({ ...base, noRoute: nr }).text, lost);
  assert.equal(headline({ ...base, noRoute: nr, rule: { kind: "follow" }, leader: { car: 33, gap: 9, kmh: 15 }, chain: [33, 26] }).text, lost);
  const held: CarExplain = { ...base, noRoute: nr, rule: { kind: "zone" }, blocker: { car: 33, edge: "lane:l3251" }, since: 2 };
  assert.match(headline(held).text, /^Waiting for car 33/);
  assert.equal(noRouteText(held), lost);
  assert.ok(explainText(held, clock).includes(`\n${lost}`));
  assert.ok(!explainText({ ...base, noRoute: nr }, clock).includes(`\n${lost}`), "said once, as the headline");
  // (two cars round a ring at 15 km/h: chain [33, 26], no deadlock from the sim: no "Deadlock" in the words)
  const loop: CarExplain = { ...base, car: 26, speed: { kmh: 15, desiredKmh: 30, targetKmh: 15, accel: 0 }, rule: { kind: "follow" }, leader: { car: 33, gap: 12, kmh: 15 }, chain: [33, 26], deadlock: null, noRoute: nr };
  assert.ok(!/deadlock/i.test(headline(loop).text) && !/DEADLOCK/.test(explainText(loop, clock)));
  assert.ok(explainText(loop, clock).includes("Blocking chain: 26 → 33 → 26  (a loop, still moving: not a deadlock)"));
  assert.equal(noRouteText({ ...base, noRoute: null }), null);
});

t("a give-way's numbers (T171b): round the ring, seconds to the crossing, what it needs; off a ring without the ring", () => {
  const gw = (b: Partial<NonNullable<CarExplain["blocker"]>>, detail?: string) => ({ ...base, rule: { kind: "give-way" as const, ...(detail ? { detail } : {}) }, blocker: { car: 128, edge: "lane:l3257", ...b }, since: 2.1 });
  assert.equal(headline(gw({ round: 23, theirSec: 4.5, mySec: 3.3, wantSec: 1.5 })).text, "Giving way to car 128 on lane l3257, 23 m round the ring, 4.5 s from the crossing; needs 3.3 s + 1.5 s to spare (2.1 s)");
  assert.equal(headline(gw({ theirSec: 4.5, mySec: 3.3, wantSec: 1.5 }, "give-way line")).text, "Giving way to car 128 on lane l3257, 4.5 s from the crossing; needs 3.3 s + 1.5 s to spare (you have a give-way line, 2.1 s)");
  assert.equal(headline(gw({ theirSec: 4.5, mySec: 3.3 })).text, "Giving way to car 128 on lane l3257, 4.5 s from the crossing; needs 3.3 s (2.1 s)");
  // (no numbers: as before)
  assert.equal(headline(gw({})).text, "Waiting for car 128 crossing its path on lane l3257 (give way, 2.1 s)");
  assert.ok(explainText(gw({ round: 23, theirSec: 4.5, mySec: 3.3, wantSec: 1.5 }), clock).includes("Held by: car 128 on lane l3257 (23 m round the ring, 4.5 s from the crossing, this one needs 3.3 s + 1.5 s to spare)"));
});

console.log(`car-explain: ${ok} checks passed`);
