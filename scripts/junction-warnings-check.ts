/**
 * Junction warnings on small sketches (T177): a way on joining a lane 2 m after a way off leaves it, the two connectors running
 * through each other, is flagged ("on-after-off", both connectors and the gap named); the same way on 10 m further on is not; nor is
 * one joining 2 m before the way off (the way on first, then off: as a roundabout's arm should be).   npm run warnings:check
 */
import { junctionWarnings } from "../src/lib/junction-warnings";
import type { Sketch, SketchConnector, SketchLane } from "../src/lib/lane-sketch";

const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string, ts: number): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: ts } });
const sketch = (lanes: SketchLane[], connectors: SketchConnector[]): Sketch => ({ lanes, connectors, roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } });
let allOk = true;
const report = (name: string, ok: boolean, text: string) => { console.log(`${name}: ${text} | ok ${ok}`); allOk &&= ok; };

// (a lane L along y = 0; the way off leaves it at 50 m for OUT, up and on; ways on from IN, above and behind)
const base = [line("L", [[0, 0], [100, 0]]), line("OUT", [[56, 10], [60, 40]]), line("IN", [[20, 25], [42, 10]])];
const flags = (sk: Sketch) => junctionWarnings(sk).filter(w => w.kind === "on-after-off");
{
  const ws = flags(sketch(base, [conn("cOff", "L", 50, "OUT", 0), conn("cOn", "IN", 26.6, "L", 52)]));
  const w = ws[0];
  report("overlapping", ws.length === 1 && w.items.includes("cOn") && w.items.includes("cOff") && /2\.0 m after/.test(w.text), w ? w.text : "not flagged");
}
{
  const ws = flags(sketch(base, [conn("cOff", "L", 50, "OUT", 0), conn("cOn", "IN", 26.6, "L", 62)]));
  report("10 m apart", ws.length === 0, ws.length ? ws[0].text : "not flagged");
}
{
  const ws = flags(sketch(base, [conn("cOff", "L", 50, "OUT", 0), conn("cOn", "IN", 26.6, "L", 48)]));
  report("on before off", ws.length === 0, ws.length ? ws[0].text : "not flagged");
}
console.log(allOk ? "junction warnings check: all ok" : "junction warnings check: FAILED");
if (!allOk) process.exit(1);
