/** The Ctrl+K search's ranking on a small sketch: `npx tsx scripts/search-check.ts` */
import { catalogue, search } from "../src/components/v2/sketch-search";
import type { JunctionContents, Sketch } from "../src/lib/lane-sketch";

const line = (id: string, x0: number, x1: number) => ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: 0 }, { x: x1, y: 0 }] } });
const sk: Sketch = {
  lanes: [line("l709", 0, 50), line("l2382", 60, 120), line("l7", 130, 160)],
  connectors: [{ id: "c2011", from: { lane: "l709", s: 50 }, to: { lane: "l2382", s: 0 } }],
  roads: [{ id: "r1", name: "Strada Gării", lanes: ["l2382"] }],
  junctions: [
    { id: "j295", name: "Junction 295", outline: [] },
    { id: "j709", name: "Junction 709", outline: [] },
    { id: "j1709", name: "Junction 1709", outline: [] },
  ],
};
const contents = new Map<string, JunctionContents>([["j295", { lanes: [], connectors: ["c2011"], roads: ["r1"] }]]);
const items = catalogue(sk, contents, [{ id: 709 }]);
const first = (q: string) => search(items, q)[0]?.id;
const cases: [string, string][] = [
  ["Junction 709", "j709"], ["junction 709", "j709"], ["JUNCTION 709", "j709"],
  ["709", "j709"], ["j709", "j709"], ["l709", "l709"], ["c2011", "c2011"],
  ["junction 7", "j709"], ["garii", "r1"], ["Strada Gării", "r1"], ["#709", "709"], ["l7", "l7"],
];
let ok = true;
for (const [q, want] of cases) {
  const got = first(q), pass = got === want;
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} "${q}" → ${got} (want ${want})`);
}
process.exit(ok ? 0 : 1);
