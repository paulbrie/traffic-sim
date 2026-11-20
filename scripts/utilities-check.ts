/**
 * The sketch's utility networks (ticket #280): water (clean, waste), gas and electricity lines through 3D nodes; drawing
 * (joining a node, a tee on a line), editing, merging, networks kept apart, sanitizing, copy/paste, moving, patches.
 * `npm run utilities:check`
 */
import { copyPart, emptySketch, pastePart, piecePoints, rotation, sanitizeSketch, transformPiece, translation, type Sketch } from "../src/lib/lane-sketch";
import {
  addUtilityLine,
  deleteUtilityLines,
  deleteUtilityNode,
  insertNode,
  lineLength,
  linesThrough,
  mergeUtilityNodes,
  moveUtilityNode,
  NET_INFO,
  nodeMap,
  offsetPolyline,
  removeNodeFromLine,
  sanitizeUtilities,
  strandOffsets,
  updateUtilityLine,
  utilityLineAt,
  utilityNodeAt,
  utilityTotals,
} from "../src/lib/sketch-utilities";
import { applyPatch } from "../src/lib/sketch-diff";
import { emptyContent } from "../src/lib/sketch-list";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const P = (x: number, y: number) => ({ p: { x, y } });

// A buried water main, three new nodes at the network's depth.
let sk: Sketch = emptySketch();
/** a line added to `sk` (kept), answered */
const add = (...a: Parameters<typeof addUtilityLine> extends [Sketch, ...infer R] ? R : never) => { const [next, l] = addUtilityLine(sk, ...a); sk = next; return l; };
const main = add("water", [P(0, 0), P(50, 0), P(100, 0)], { buried: true });
check("a water main: 3 nodes, buried, at the water network's depth", !!main && main.nodes.length === 3 && main.buried === true && sk.utilityNodes!.every(n => n.z === NET_INFO.water.depth && n.net === "water"));
check("its name and id", main!.id === "u1" && main!.name === "Water main 1");
check("its length: 100 m on the plan, the same in 3D on flat ground", near(lineLength(sk, main!).plan, 100) && near(lineLength(sk, main!).real, 100));
check("a sketch with only utilities is a sketch still (saved, not empty)", !!sanitizeSketch(sk) && !emptyContent(sk));

// A branch: starting on the main's middle node (joined there), and a tee on the main between its nodes.
const mid = main!.nodes[1];
const branch = add("water", [{ p: { x: 50, y: 0 }, node: mid }, P(50, 40)], { buried: true });
check("a branch from the main's node joins it there", !!branch && branch.nodes[0] === mid && linesThrough(sk, mid).length === 2);
const tee = add("water", [{ p: { x: 75, y: 0 }, on: { line: main!.id, seg: 1 } }, P(75, -30)]);
const main2 = sk.utilityLines!.find(l => l.id === main!.id)!, teeNode = tee!.nodes[0];
check("a tee on the main: a node put into it between its nodes", main2.nodes.length === 4 && main2.nodes[2] === teeNode && linesThrough(sk, teeNode).length === 2);
check("the tee's node at the main's depth there (not the branch's height)", nodeMap(sk).get(teeNode)!.z === NET_INFO.water.depth);
check("the tee's other end visible: at the network's height", nodeMap(sk).get(tee!.nodes[1])!.z === NET_INFO.water.height);

// Two tees on the same segment in one line: each put where it was clicked.
const two = add("water", [{ p: { x: 10, y: 0 }, on: { line: main!.id, seg: 0 } }, P(10, 20), P(30, 20), { p: { x: 30, y: 0 }, on: { line: main!.id, seg: 0 } }]);
const xs = sk.utilityLines!.find(l => l.id === main!.id)!.nodes.map(id => nodeMap(sk).get(id)!.x);
check("two tees on one segment, each in its place along the main", !!two && JSON.stringify(xs) === JSON.stringify([0, 10, 30, 50, 75, 100]), xs.join(","));

// Networks kept apart: a gas line drawn over the water main's node doesn't join it.
const gas = add("gas", [{ p: { x: 50, y: 0 }, node: mid }, P(50, -40)], { buried: true });
check("gas over a water node: a node of its own", !!gas && gas.nodes[0] !== mid && nodeMap(sk).get(gas.nodes[0])!.net === "gas");
check("found by network: the water node, the gas line", utilityNodeAt(sk, { x: 50.3, y: 0 }, 1, n => n === "water")?.id === mid && utilityLineAt(sk, { x: 50.5, y: -20 }, 1, n => n === "gas")?.line === gas!.id);

// Overhead power on poles: 3 conductors side by side.
const power = add("power", [P(0, 100), P(60, 100)], { count: 3, size: 0.4 });
check("an overhead power line: its nodes at the pole height, 3 conductors", !!power && power.count === 3 && sk.utilityNodes!.filter(n => power!.nodes.includes(n.id)).every(n => n.z === 9) && power.size === 0.4);
const offs = strandOffsets(power!);
check("its conductors side by side, centred", offs.length === 3 && near(offs[0], -offs[2]) && near(offs[1], 0));
const left = offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1);
check("offset to the left as it runs (y down: north of an eastward line)", near(left[0].y, -1) && near(left[1].y, -1));

// 3D: a node raised, the 3D length longer; over a hill (the ground's height) too.
sk = moveUtilityNode(sk, power!.nodes[1], { z: 9 + 60 * Math.tan(Math.PI / 6) });
check("a node raised: its line's 3D length longer (a 30° rise over 60 m)", near(lineLength(sk, sk.utilityLines!.find(l => l.id === power!.id)!).real, 60 / Math.cos(Math.PI / 6), 0.01));
const hill = (p: { x: number }) => p.x;
check("over a slope (ground climbing 1 m a metre): the 3D length counts it", near(lineLength(sk, sk.utilityLines!.find(l => l.id === gas!.id)!, hill).real, 40));
check("z kept within bounds", nodeMap(moveUtilityNode(sk, mid, { z: -1000 })).get(mid)!.z === -100);

// Editing: buried / not, the network changed (shared nodes copied), size, count.
const visible = updateUtilityLine(sk, branch!.id, { buried: false });
check("the branch made visible: its nodes on the wrong side raised (the shared one too)", visible.utilityLines!.find(l => l.id === branch!.id)!.buried === undefined && nodeMap(visible).get(mid)!.z === NET_INFO.water.height);
const sewer = updateUtilityLine(sk, branch!.id, { net: "sewer" }), sb = sewer.utilityLines!.find(l => l.id === branch!.id)!;
check("the branch made waste water: its node shared with the main copied, the main's own kept", sb.net === "sewer" && sb.nodes[0] !== mid && nodeMap(sewer).get(mid)!.net === "water" && nodeMap(sewer).get(sb.nodes[0])!.net === "sewer" && nodeMap(sewer).get(sb.nodes[1])!.net === "sewer");
const elec = updateUtilityLine(updateUtilityLine(sk, branch!.id, { size: 200 }), branch!.id, { net: "power" });
check("made electricity: a size in mm let go (kV now)", elec.utilityLines!.find(l => l.id === branch!.id)!.size === undefined);
const sized = updateUtilityLine(sk, main!.id, { size: 300, count: 2 });
check("size and count set; back to the network's size: not stored", sized.utilityLines!.find(l => l.id === main!.id)!.size === 300 && sized.utilityLines!.find(l => l.id === main!.id)!.count === 2 && updateUtilityLine(sized, main!.id, { size: 150, count: 1 }).utilityLines!.find(l => l.id === main!.id)!.size === undefined);

// Nodes: put in, taken out of a line, deleted, merged.
const [withN, nid] = insertNode(sk, gas!.id, 0, { x: 50, y: -20 });
check("a node put into the gas line, its height between its ends'", !!nid && withN.utilityLines!.find(l => l.id === gas!.id)!.nodes.length === 3 && nodeMap(withN).get(nid!)!.z === NET_INFO.gas.depth);
const out = removeNodeFromLine(withN, gas!.id, 1);
check("taken out again: the node goes (no other line through it)", out.utilityLines!.find(l => l.id === gas!.id)!.nodes.length === 2 && !nodeMap(out).has(nid!));
check("a line keeps two nodes at least", removeNodeFromLine(sk, gas!.id, 0) === sk);
const noMid = deleteUtilityNode(sk, mid), m3 = noMid.utilityLines!.find(l => l.id === main!.id)!;
check("the main's middle node deleted: the main joined across, the branch (one node left) gone", !m3.nodes.includes(mid) && !noMid.utilityLines!.some(l => l.id === branch!.id) && !nodeMap(noMid).has(branch!.nodes[1]));
const end = branch!.nodes[1], other = sk.utilityLines!.find(l => l.id === tee!.id)!.nodes[1];
const merged = mergeUtilityNodes(sk, other, end);
check("the branch's end dropped on the tee's: one node, both lines through it", !nodeMap(merged).has(end) && linesThrough(merged, other).length === 2);
check("nodes of two networks never merge", mergeUtilityNodes(sk, mid, gas!.nodes[1]) === sk);
const noGas = deleteUtilityLines(sk, [gas!.id]);
check("the gas line deleted: its nodes too", !noGas.utilityLines!.some(l => l.net === "gas") && !noGas.utilityNodes!.some(n => n.net === "gas"));
const totals = utilityTotals(sk);
check("totals per network", totals.water.lines === 4 && totals.gas.lines === 1 && totals.power.lines === 1 && near(totals.gas.length, 40) && totals.sewer.lines === 0);

// Stored: checked.
const raw = {
  nodes: [{ id: "n1", net: "water", x: 0, y: 0, z: -1 }, { id: "n2", net: "water", x: 5, y: 0 }, { id: "n1", net: "gas", x: 1, y: 1 }, { id: "n3", net: "gas", x: 9, y: 9, z: 2 }, { id: "n4", net: "oil", x: 0, y: 0 }, { id: "n5", net: "water", x: Number.NaN, y: 0 }],
  lines: [
    { id: "u1", net: "water", nodes: ["n1", "n2", "n2"], count: 40, size: 150 },
    { id: "u2", net: "water", nodes: ["n1", "n3"] },
    { id: "u3", net: "gas", nodes: ["n3"] },
    { id: "u1", net: "water", nodes: ["n1", "n2"] },
  ],
};
const san = sanitizeUtilities(raw.nodes, raw.lines);
check("stored nodes checked: unknown networks, repeated ids, no position dropped; z 0 if missing", san.nodes.map(n => n.id).join() === "n1,n2,n3" && san.nodes[1].z === 0);
check("stored lines checked: repeated nodes once, another network's nodes and short lines dropped, count capped, default size not kept",
  san.lines.length === 1 && san.lines[0].nodes.join() === "n1,n2" && san.lines[0].count === 12 && san.lines[0].size === undefined);
const round = sanitizeSketch(JSON.parse(JSON.stringify(sk)));
check("a sketch round-trips through JSON with its utilities", JSON.stringify(round?.utilityLines) === JSON.stringify(sk.utilityLines) && JSON.stringify(round?.utilityNodes) === JSON.stringify(sk.utilityNodes));

// Pieces: moved, turned, copied, pasted.
const piece = { lanes: [], connectors: [], junctions: [], utilities: [gas!.id] };
check("a piece's points: its lines' nodes", piecePoints(sk, piece).length === 2);
const moved = transformPiece(sk, piece, translation(10, 5));
check("moved: the gas line's nodes, nothing else", nodeMap(moved).get(gas!.nodes[1])!.x === 60 && nodeMap(moved).get(gas!.nodes[1])!.y === -35 && nodeMap(moved).get(mid)!.x === 50);
const turned = transformPiece(sk, { ...piece, utilities: [power!.id] }, rotation({ x: 0, y: 100 }, Math.PI / 2));
check("turned a quarter about its start: the power line runs south, its heights kept", near(nodeMap(turned).get(power!.nodes[1])!.y, 160, 0.01) && near(nodeMap(turned).get(power!.nodes[1])!.x, 0, 0.01) && nodeMap(turned).get(power!.nodes[1])!.z === nodeMap(sk).get(power!.nodes[1])!.z);
const part = copyPart(sk, { ...piece, utilities: [main!.id, branch!.id] });
check("copied: the two lines and their nodes alone", part.utilityLines?.length === 2 && part.utilityNodes?.length === 7);
const pasted = pastePart(sk, part, 0, 200), pl = pasted.sketch.utilityLines!.filter(l => pasted.piece.utilities!.includes(l.id));
const pm = nodeMap(pasted.sketch);
check("pasted: new ids, '… copy', moved, still joined to each other, not to the originals",
  pl.length === 2 && pl.every(l => l.name.endsWith(" copy") && l.nodes.every(n => pm.get(n)!.y >= 200)) && pl[0].nodes.some(n => pl[1].nodes.includes(n)) && pasted.sketch.utilityLines!.length === sk.utilityLines!.length + 2);

// A patch (History's Apply changes from file, an agent's): a node raised, a line added, one removed with its nodes.
const patched = applyPatch(sk, {
  utilityNodes: [{ id: mid, z: -3 }, { id: "n90", net: "gas", x: 0, y: -60, z: -1 }],
  utilityLines: [{ id: "u90", net: "gas", name: "Service", nodes: [gas!.nodes[1], "n90"] }],
  remove: { utilityLines: [power!.id], utilityNodes: power!.nodes },
});
check("a patch raises a node, adds a gas line joined to the gas network, removes the power line",
  !!patched && nodeMap(patched).get(mid)!.z === -3 && patched.utilityLines!.some(l => l.id === "u90") && !patched.utilityLines!.some(l => l.net === "power") && !patched.utilityNodes!.some(n => n.net === "power"));
const refused = applyPatch(sk, { remove: { utilityNodes: [mid] } });
check("a patch removing a node lines still run through is refused (they'd go unlisted)", refused === null);

console.log(ok ? "utilities check: all ok" : "utilities check: FAILED");
process.exit(ok ? 0 : 1);
