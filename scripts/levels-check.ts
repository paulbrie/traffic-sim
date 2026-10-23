/**
 * Road levels (bridges and tunnels): the ramp a lane climbs to its level, and which pass a car draws in while on it
 * (ticket #79: cars not showing when entering a road with higher level, reappearing only in the middle of the
 * segment). `npm run levels:check`
 */
import { connectorLevel, edgeLevel, laneById, laneLevel, sanitizeSketch, zAt, type Sketch } from "../src/lib/lane-sketch";

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const line = (id: string, x0: number, x1: number, level?: number) =>
  ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: 0 }, { x: x1, y: 0 }] }, ...(level ? { level } : {}) });

// ground (0..50) into a bridge (50..170, level 1, 120 m long): the connector joins right at each end, so the bridge
// ramps up from the ground for the first 45 m (0.45 * 120, under the 100 m/level cap) of its own length
const sk: Sketch = sanitizeSketch({
  lanes: [line("ground", 0, 50), line("bridge", 50, 170, 1)],
  connectors: [{ id: "k1", from: { lane: "ground", s: 50 }, to: { lane: "bridge", s: 0 } }],
  roads: [],
  junctions: [],
})!;
const ra = 0.45 * 120;

check(zAt(sk, "bridge", 0) < 0.05, `the bridge starts at ground level (${zAt(sk, "bridge", 0).toFixed(2)})`);
check(Math.abs(zAt(sk, "bridge", ra) - 1) < 0.05, `the bridge reaches its own level by the end of its ramp (${zAt(sk, "bridge", ra).toFixed(2)} at ${ra} m)`);

// the mismatch ticket #79 is about: early on the ramp, a car's height says "ground" while its lane's own
// surface — drawn for the lane's whole length, ramp included — says "up": a car there would be hidden under its
// own bridge's deck until its height happened to catch up, around the ramp's middle
const early = 10;
check(zAt(sk, "bridge", early) < 0.5, `early on the ramp (${early} m in) the car's height is still under the bridge's own level (${zAt(sk, "bridge", early).toFixed(2)})`);
check(laneLevel(laneById(sk, "bridge")) >= 1, "but the bridge lane's own surface is drawn in the 'up' pass for its whole length, ramp included");

// edgeLevel (ticket #79's fix) goes by the car's own edge, not its height, so it agrees with the lane's surface
// pass at every point along the ramp, not only past its middle
let mismatches = 0, agreements = 0;
for (let s = 0; s <= 120; s += 1) {
  const byHeight = zAt(sk, "bridge", s) >= 0.5, bySurface = laneLevel(laneById(sk, "bridge")) >= 1;
  if (byHeight !== bySurface) mismatches++;
  if ((edgeLevel(sk, "lane:bridge") >= 0.5) === bySurface) agreements++;
}
check(mismatches > 20, `height-based classification would disagree with the lane's own surface pass for a real stretch of the ramp (${mismatches} of 121 points sampled)`);
check(agreements === 121, `edgeLevel agrees with the lane's own surface pass at every point sampled (${agreements} of 121)`);

// a car still on the approach, or on the connector into the bridge (at the ground end, as the ramp starts): ground
check(edgeLevel(sk, "lane:ground") === 0, "a car on the ground lane: level 0");
check(edgeLevel(sk, "conn:k1") === connectorLevel(sk, sk.connectors[0]) && edgeLevel(sk, "conn:k1") < 0.5, "a car on the connector into the bridge: still ground, matching connectorLevel");

// a sketch without levels, or an unknown/missing edge: no lookups, no crash
const flat: Sketch = sanitizeSketch({ lanes: [line("a", 0, 10)], connectors: [], roads: [], junctions: [] })!;
check(edgeLevel(flat, "lane:a") === 0, "a sketch with no levels: always ground");
check(edgeLevel(sk, undefined) === 0 && edgeLevel(sk, "lane:zzz") === 0 && edgeLevel(sk, "nope") === 0, "a missing edge, unknown lane, or odd key: ground, not a throw");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
