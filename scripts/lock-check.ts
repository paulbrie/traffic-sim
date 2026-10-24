/**
 * Locks (ticket #93): a lane, road or junction locked can't be changed until unlocked. Checks `lockedChange` (what an edit
 * changes that is locked: refused by the editor's store) and `setLocked` on a small sketch: a locked lane moved, deleted or
 * renamed by its road; a locked road's lanes; a locked junction's border; what is not locked still free; locking itself
 * no change; and the locks kept through sanitizeSketch (saved with the plan).   npm run lock:check
 */
import { lockedChange, laneLocked, reshape, remove, sanitizeSketch, setLocked, type Sketch } from "../src/lib/lane-sketch";

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const line = (x0: number, y: number, x1: number) => ({ kind: "line" as const, pts: [{ x: x0, y }, { x: x1, y }] });
const base: Sketch = {
  lanes: [{ id: "l1", shape: line(0, 0, 50), width: 3.5 }, { id: "l2", shape: line(0, 4, 50), width: 3.5 }, { id: "l3", shape: line(60, 0, 100), width: 3.5 }],
  connectors: [], roads: [{ id: "r1", name: "Strada A", lanes: ["l1", "l2"] }],
  junctions: [{ id: "j1", name: "Junction 1", outline: [{ x: 50, y: -5 }, { x: 60, y: -5 }, { x: 60, y: 10 }, { x: 50, y: 10 }] }],
};
const moved = (sk: Sketch, id: string) => reshape(sk, id, line(0, 1, 55));
const none = { lanes: [] as string[], connectors: [] as string[], junctions: [] as string[] };

// a lane locked
{
  const sk = setLocked(base, { lanes: ["l3"] }, true);
  check(!!sk.lanes.find(l => l.id === "l3")?.locked && laneLocked(sk, "l3") && !laneLocked(sk, "l1"), "a lane locked: it alone");
  check(lockedChange(base, sk) === null, "locking is no change");
  check(lockedChange(sk, setLocked(sk, { lanes: ["l3"] }, false)) === null, "unlocking is no change");
  check(lockedChange(sk, moved(sk, "l3")) === "lane l3", "a locked lane moved: refused");
  check(lockedChange(sk, { ...sk, lanes: sk.lanes.map(l => (l.id === "l3" ? { ...l, width: 3 } : l)) }) === "lane l3", "a locked lane's width changed: refused");
  check(lockedChange(sk, remove(sk, { ...none, lanes: ["l3"] })) === "lane l3", "a locked lane deleted: refused");
  check(lockedChange(sk, moved(sk, "l1")) === null, "another lane moved: free");
  check(setLocked(sk, { lanes: ["l3"] }, true) === sk, "locking what is locked: the same sketch");
}
// a road locked: it and its lanes
{
  const sk = setLocked(base, { roads: ["r1"] }, true);
  check(laneLocked(sk, "l1") && laneLocked(sk, "l2") && !laneLocked(sk, "l3"), "a road locked: its lanes locked with it");
  check(lockedChange(sk, moved(sk, "l1")) === "lane l1 (with its road Strada A)", "a lane of a locked road moved: refused");
  check(lockedChange(sk, { ...sk, roads: sk.roads.map(r => ({ ...r, name: "Strada B" })) }) === "road Strada A", "a locked road renamed: refused");
  check(lockedChange(sk, { ...sk, roads: sk.roads.map(r => ({ ...r, lanes: ["l1"] })) }) === "road Strada A", "a lane taken out of a locked road: refused");
  check(lockedChange(sk, moved(sk, "l3")) === null, "a lane in no locked road moved: free");
}
// a junction locked
{
  const sk = setLocked(base, { junctions: ["j1"] }, true);
  check(lockedChange(sk, { ...sk, junctions: sk.junctions.map(j => ({ ...j, outline: j.outline.map(p => ({ x: p.x + 1, y: p.y })) })) }) === "Junction 1", "a locked junction's border moved: refused");
  check(lockedChange(sk, { ...sk, junctions: sk.junctions.map(j => ({ ...j, shape: "auto" as const })) }) === "Junction 1", "a locked junction's surface changed: refused");
  check(lockedChange(sk, { ...sk, junctions: [] }) === "Junction 1", "a locked junction deleted: refused");
  check(lockedChange(sk, moved(sk, "l1")) === null, "a lane beside a locked junction moved: free");
}
// saved with the plan
{
  const sk = sanitizeSketch(JSON.parse(JSON.stringify(setLocked(base, { lanes: ["l3"], roads: ["r1"], junctions: ["j1"] }, true))))!;
  check(!!sk.lanes.find(l => l.id === "l3")?.locked && !!sk.roads[0].locked && !!sk.junctions[0].locked, "the locks kept through sanitizeSketch");
  check(!sanitizeSketch(JSON.parse(JSON.stringify(base)))!.lanes.some(l => "locked" in l), "nothing locked: no lock field added");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
