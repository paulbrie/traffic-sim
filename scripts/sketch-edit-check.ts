/** What pauses the cars (T158): map edits, not the run's settings; and what undo keeps (T160). `npm run edit:check` */
import { mapChanged, stepBack } from "../src/lib/sketch-edit";
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
// T160: undo and redo take the map back, keeping the run's settings changed since the step
const moved = lanes(l => (l.id === "a" ? { ...l, shape: { kind: "line", pts: [{ x: 0, y: 1 }, { x: 50, y: 1 }] } } : l));
const laneA = (k: Sketch) => k.lanes.find(l => l.id === "a")!;
const demand = (k: Sketch): Sketch => ({ ...k, traffic: { rate: 900, speed: 40, seed: 7 }, journeys: [{ id: "t1", from: "a", to: "b", rate: 100 }], lanes: k.lanes.map(l => (l.id === "a" ? { ...l, inRate: 300 } : l.id === "b" ? { ...l, outWeight: 2 } : l)) });
const back = stepBack(sk, moved, demand(moved));
check("a lane move undone after the demand changed: the lane back, the traffic, journeys and demand kept", laneA(back).shape === laneA(sk).shape && back.traffic?.rate === 900 && back.traffic.seed === 7 && back.journeys?.length === 1 && laneA(back).inRate === 300 && back.lanes[1].outWeight === 2);
// (the step redo takes: back to the sketch undo left, from what undo made; the traffic set again in between)
const again = stepBack(demand(moved), back, { ...back, traffic: { rate: 1200, speed: 40 } });
check("…and redone: the lane moved again, the demand kept, the traffic set in between kept", laneA(again).shape === laneA(moved).shape && laneA(again).inRate === 300 && again.traffic?.rate === 1200 && again.journeys?.length === 1);
check("a map edit undone or redone alone: exactly the sketch it was", stepBack(sk, moved, moved) === sk && stepBack(moved, sk, sk) === moved);
const raised = lanes(l => (l.id === "a" ? { ...l, inRate: 300 } : l));
check("a change of the demand undone (itself a step): taken back", laneA(stepBack(sk, raised, raised)).inRate === undefined && laneA(stepBack(sk, raised, { ...raised, traffic: { rate: 900, speed: 50 } })).inRate === undefined);
const withJ: Sketch = { ...sk, journeys: [{ id: "t1", from: "a", to: "b", rate: 100 }] }, noB: Sketch = { ...withJ, lanes: [sk.lanes[0]], journeys: undefined };
check("a lane delete undone: its journeys back with it, unless the journeys changed since", stepBack(withJ, noB, noB).journeys?.length === 1 && stepBack(withJ, noB, { ...noB, journeys: [{ id: "t2", from: "a", to: "a", rate: 50 }] }).journeys?.[0].id === "t2");
const added: Sketch = { ...sk, lanes: [...sk.lanes, line("c", 130, 180)] }, toC: Sketch = { ...added, journeys: [{ id: "t3", from: "a", to: "c", rate: 80 }] };
check("a lane added, a journey to it, the add undone: the journey naming it lets go", !stepBack(sk, added, toC).journeys?.length && !stepBack(sk, added, toC).lanes.some(l => l.id === "c"));
process.exit(ok ? 0 : 1);
