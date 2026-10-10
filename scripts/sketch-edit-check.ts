/** What pauses the cars (T158): map edits, not the run's settings. `npm run edit:check` */
import { mapChanged } from "../src/lib/sketch-edit";
import { sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean) => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}`); };
const line = (id: string, x0: number, x1: number) => ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: 0 }, { x: x1, y: 0 }] } });
const sk: Sketch = sanitizeSketch({ lanes: [line("a", 0, 50), line("b", 60, 120)], connectors: [{ id: "k1", from: { lane: "a", s: 50 }, to: { lane: "b", s: 0 } }], roads: [], junctions: [{ id: "j1", name: "J", outline: [{ x: 45, y: -5 }, { x: 65, y: -5 }, { x: 65, y: 5 }] }], traffic: { rate: 600, speed: 50 } })!;
const lanes = (f: (l: Sketch["lanes"][number]) => Sketch["lanes"][number]) => ({ ...sk, lanes: sk.lanes.map(f) });

check("the same sketch: no change", !mapChanged(sk, sk));
check("traffic (rate, speed, seed): not the map", !mapChanged(sk, { ...sk, traffic: { rate: 900, speed: 50, seed: 3 } }));
check("journeys: not the map", !mapChanged(sk, { ...sk, journeys: [{ id: "t1", from: "a", to: "b", rate: 100 }] }));
check("demand on a way in or out (a lane's inRate / outWeight): not the map", !mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, inRate: 300 } : l))) && !mapChanged(sk, lanes(l => (l.id === "b" ? { ...l, outWeight: 2 } : l))));
check("a lane moved: the map", mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, shape: { kind: "line", pts: [{ x: 0, y: 1 }, { x: 50, y: 1 }] } } : l))));
check("a lane's width, sign or speed limit: the map", mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, width: 3 } : l))) && mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, control: "stop" as const } : l))) && mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, speed: 30 } : l))));
check("a lane added or deleted: the map", mapChanged(sk, { ...sk, lanes: sk.lanes.slice(1) }));
check("a connector, a junction's lights, a road: the map", mapChanged(sk, { ...sk, connectors: [] }) && mapChanged(sk, { ...sk, junctions: sk.junctions.map(j => ({ ...j, lights: { cycle: 60 } as never })) }) && mapChanged(sk, { ...sk, roads: [{ id: "r1", name: "R", lanes: ["a"] }] }));
check("demand and a move together: the map", mapChanged(sk, lanes(l => (l.id === "a" ? { ...l, inRate: 300, width: 3 } : l))));
check("zones and crossings: the map", mapChanged(sk, { ...sk, zones: [{ id: "z1", name: "Z", outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], color: "#3b82f6" }] }) && mapChanged(sk, { ...sk, crossings: [{ id: "x1", a: { x: 20, y: -4 }, b: { x: 20, y: 4 }, width: 4, peds: 300 }] }));
process.exit(ok ? 0 : 1);
