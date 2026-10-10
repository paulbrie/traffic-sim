// Agent patches (T132): what a submit accepts and refuses, and applying one: one save through the same path as
// "Apply changes from file", noted "Agent patch #n (T56, Bob): title" and recorded as its own kind; a conflict
// refuses with the new revision; the page's own file action can't pass itself off as a patch. Removals (T140) and
// a piece added to the Sketch window (T152).
import { strict as assert } from "node:assert";
import { checkPatch, patchNote, authorColor } from "../src/lib/agent-patch";
import { readSketchFile } from "../src/lib/sketch-diff";
import { restoreFromFile, type RestoreFileDeps } from "../src/server/restore-file";
import { sanitizeSketch } from "../src/lib/lane-sketch";
import type { SaveResult } from "../src/server/data/plans";

const line = (id: string, x0: number, x1: number, y = 0) => ({ id, shape: { kind: "line", pts: [{ x: x0, y }, { x: x1, y }] }, width: 3.5 });
const base = {
  lanes: [line("a", 0, 50), line("b", 60, 120)],
  connectors: [{ id: "k1", from: { lane: "a", s: 50 }, to: { lane: "b", s: 0 } }],
  roads: [{ id: "r1", name: "Main", lanes: ["a", "b"] }],
  junctions: [],
};
const cur = sanitizeSketch(base)!;
let ok = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); ok++; console.log(`ok  ${name}`); };

type Saved = Parameters<RestoreFileDeps["save"]>[0];
function deps(stored = 7) {
  const saves: Saved[] = [];
  const d: RestoreFileDeps = {
    canEdit: true,
    current: async () => ({ engine: "v2", network: { nodes: [] }, settings: { s: 1 }, underlay: null, sketch: base }),
    save: async s => { saves.push(s); return (s.revision === stored ? { ok: true, revision: stored + 1, savedAt: "" } : { ok: false, reason: "conflict", revision: stored }) as SaveResult; },
  };
  return { d, saves };
}

async function main() {
  await t("submit: a real change is accepted, with its summary", () => {
    const r = checkPatch(JSON.stringify({ lanes: [{ id: "b", width: 5 }] }), cur);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.summary.items.map(x => [x.id, x.change, x.fields]), [["b", "changed", ["width"]]]);
  });

  await t("submit: refused when it isn't a patch, when anything would be left out, or when nothing would change", () => {
    const no = (text: string) => { const r = checkPatch(text, cur); assert.equal(r.ok, false, text); return r.ok ? [] : r.errors; };
    assert.match(no("{oops")[0], /valid JSON/);
    assert.match(no(JSON.stringify({ network: {} }))[0], /no sketch items/);
    // one good item and one refused: refused as a whole, the refused one named with why
    const errs = no(JSON.stringify({ lanes: [{ id: "b", width: 5 }, { id: "a", shape: null }, { id: "z", width: 3 }] }));
    assert.deepEqual(errs, ["lane a: left out (invalid; the current one stays) (shape can't be cleared)", "lane z: left out (invalid) (a new item must have all its fields)"]);
    assert.match(no(JSON.stringify({ lanes: [line("a", 0, 50)] }))[0], /Nothing would change/);
  });

  await t("the version note names the patch, its task and author", () => {
    assert.equal(patchNote({ id: 12, task: "T56", author: "Bob", title: "j534: give way on the minor arm" }), "Agent patch #12 (T56, Bob): j534: give way on the minor arm");
    assert.equal(patchNote({ id: 3, task: "", author: "Bob", title: "x" }), "Agent patch #3 (Bob): x");
    assert.equal(authorColor("Bob"), authorColor("Bob"));
    assert.notEqual(authorColor("Bob"), authorColor("Alice"));
  });

  await t("apply: one save, from the previewed revision, noted and recorded as an agent patch", async () => {
    const m = deps();
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [{ id: "b", width: 5 }] }, revision: 7, patch: { note: "Agent patch #12 (T56, Bob): wider b" } }, m.d);
    assert.deepEqual(r, { ok: true, revision: 8 });
    assert.equal(m.saves.length, 1);
    assert.deepEqual(m.saves[0].restore, { note: "Agent patch #12 (T56, Bob): wider b", kind: "patch" });
    assert.equal(m.saves[0].sketch.lanes.find(l => l.id === "b")!.width, 5);
    assert.deepEqual(m.saves[0].sketch.connectors, cur.connectors);
  });

  await t("apply: the plan saved in between refuses, with the new revision", async () => {
    const m = deps(9);
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [{ id: "b", width: 5 }] }, revision: 7, patch: { note: "x" } }, m.d);
    assert.equal(r.ok ? 0 : r.revision, 9);
  });

  await t("a restore can't be recorded as a patch (the patch note is for applying only)", async () => {
    const m = deps();
    await restoreFromFile({ mode: "restore", file: base, revision: 7, patch: { note: "Agent patch #1 (x): y" }, fileName: "f.json" }, m.d);
    assert.equal(m.saves[0].restore.kind, "restore");
    assert.match(m.saves[0].restore.note, /^Restored from the file f\.json/);
  });

  // ---- removals (T140)
  const rich = {
    lanes: [line("a", 0, 50), line("b", 60, 120), line("c", 130, 190), line("u", 120, 60, 5)],
    connectors: [
      { id: "k1", from: { lane: "a", s: 50 }, to: { lane: "b", s: 0 } },
      { id: "k2", from: { lane: "b", s: 60 }, to: { lane: "c", s: 0 } },
      { id: "kU", from: { lane: "b", s: 60 }, to: { lane: "u", s: 0 } },
    ],
    roads: [{ id: "r1", name: "Main", lanes: ["a", "b"] }, { id: "r2", name: "Side", lanes: ["c"] }],
    junctions: [{ id: "j1", name: "J", outline: [{ x: 118, y: -6 }, { x: 132, y: -6 }, { x: 132, y: 6 }], lights: { green: 18, amber: 3, allRed: 2, mode: "each", minGreen: 6, actuated: false, phases: [{ green: 20, conns: ["k2"] }] } }],
  };
  const rc = sanitizeSketch(rich)!;
  assert.ok(rc.connectors.length === 3 && rc.junctions[0].lights?.phases?.[0].conns[0] === "k2", "fixture");
  const check = (patch: object) => checkPatch(JSON.stringify(patch), rc);

  await t("remove: a removal-only patch (B's U-turn connector) is accepted and listed as removed", () => {
    const r = check({ remove: { connectors: ["kU"] } });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
    assert.deepEqual(r.ok && r.summary.items, [{ kind: "connectors", id: "kU", change: "removed", before: "0 bend points" }]);
    assert.deepEqual(r.ok && r.summary.kinds.connectors, { added: [], removed: ["kU"], changed: [] });
    assert.equal(r.ok && r.summary.same, false);
    assert.deepEqual(r.ok && r.summary.sketch.connectors.map(c => c.id), ["k1", "k2"]);
  });

  await t("remove: a mixed patch changes and removes; a removed lane leaves its road; its connectors listed too", () => {
    const r = check({ lanes: [{ id: "a", width: 5 }], remove: { lanes: ["u"], connectors: ["kU"] } });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
    const s = r.ok ? r.summary : null!;
    assert.deepEqual(s.items.map(x => [x.id, x.change]), [["a", "changed"], ["u", "removed"], ["kU", "removed"]]);
    assert.deepEqual(s.sketch.lanes.map(l => [l.id, l.width]), [["a", 5], ["b", 3.5], ["c", 3.5]]);
  });

  await t("remove: a lane removed without its connectors is refused, naming them", () => {
    const r = check({ remove: { lanes: ["c"], roads: ["r2"] } });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.errors.join("; "), /also removes connector k2: list it in remove\.connectors/);
  });

  await t("remove: an id not in the plan, or both changed and removed, is refused", () => {
    const r = check({ remove: { connectors: ["nope"] } });
    assert.deepEqual(r.ok ? [] : r.errors, ["no connector nope in the plan to remove"]);
    const both = check({ connectors: [{ id: "kU", via: [{ x: 1, y: 1 }] }], remove: { connectors: ["kU"] } });
    assert.match(both.ok ? "" : both.errors.join("; "), /connector kU both changed and removed/);
  });

  await t("remove: a junction left naming a removed connector is refused; changing it in the same patch passes", () => {
    const r = check({ remove: { connectors: ["k2"] } });
    assert.match(r.ok ? "" : r.errors.join("; "), /junction j1 still names connector k2 \(its lights\)/);
    const fixed = check({ junctions: [{ id: "j1", lights: null }], remove: { connectors: ["k2"] } });
    assert.ok(fixed.ok, fixed.ok ? "" : fixed.errors.join("; "));
    assert.equal(fixed.ok && fixed.summary.sketch.junctions[0].lights, undefined);
    // or the junction goes with it
    assert.ok(check({ remove: { connectors: ["k2"], junctions: ["j1"] } }).ok);
  });

  await t("remove: a road left with no lane must be listed; then it goes", () => {
    const r = check({ remove: { lanes: ["c"], connectors: ["k2"], junctions: ["j1"] } });
    assert.match(r.ok ? "" : r.errors.join("; "), /road r2 would be left with no lane: list it in remove\.roads/);
    const ok2 = check({ remove: { lanes: ["c"], connectors: ["k2"], junctions: ["j1"], roads: ["r2"] } });
    assert.ok(ok2.ok, ok2.ok ? "" : ok2.errors.join("; "));
    assert.deepEqual(ok2.ok && ok2.summary.sketch.roads.map(x => x.id), ["r1"]);
  });

  await t("remove: a plain file (History's Apply changes from file) can't remove", () => {
    const r = readSketchFile(JSON.stringify({ remove: { connectors: ["kU"] } }), "apply", rc);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /only agent patches may remove/);
  });

  await t("remove: applied on the server path, one save without the removed items; the page's own action can't remove", async () => {
    const m = { saves: [] as Saved[] };
    const d: RestoreFileDeps = {
      canEdit: true,
      current: async () => ({ engine: "v2", network: { nodes: [] }, settings: {}, underlay: null, sketch: rich }),
      save: async s => { m.saves.push(s); return { ok: true, revision: 8, savedAt: "" } as SaveResult; },
    };
    const r = await restoreFromFile({ mode: "apply", file: { remove: { connectors: ["kU"] } }, revision: 7, patch: { note: "Agent patch #5 (T134, Bob): no U-turn at B" } }, d);
    assert.deepEqual(r, { ok: true, revision: 8 });
    assert.deepEqual(m.saves[0].sketch.connectors.map(c => c.id), ["k1", "k2"]);
    assert.deepEqual(m.saves[0].restore, { note: "Agent patch #5 (T134, Bob): no U-turn at B", kind: "patch" });
    const plain = await restoreFromFile({ mode: "apply", file: { remove: { connectors: ["kU"] } }, revision: 7 }, d);
    assert.equal(plain.ok, false);
    assert.equal(m.saves.length, 1);
  });

  // ---- the Sketch window (T152)
  const geo = { lat: 47.13, lon: 24.49 };
  const windowNow = { lanes: [line("l1", 0, 40), line("l2", 50, 90)], connectors: [{ id: "c1", from: { lane: "l1", s: 40 }, to: { lane: "l2", s: 0 } }], roads: [{ id: "r1", name: "Old", lanes: ["l1", "l2"] }], junctions: [], crossings: [{ id: "x1", a: { x: 20, y: -5 }, b: { x: 20, y: 5 }, width: 4, peds: 300 }], traffic: { rate: 10, speed: 40, seed: 2 } };
  const withWindow = sanitizeSketch({ ...rich, geo, scratch: windowNow })!;
  assert.ok(withWindow.scratch?.lanes.length === 2 && withWindow.scratch.crossings?.length === 1, "fixture: the window");
  // (Bob's kind of piece: its own ids, the same place as the window's content, a zebra, its own traffic)
  const piece = {
    lanes: [line("l1", 0, 30, 2), line("l366", 40, 70, 2)],
    connectors: [{ id: "c-t148-1", from: { lane: "l1", s: 30 }, to: { lane: "l366", s: 0 } }],
    roads: [{ id: "r1607", name: "Strada", lanes: ["l1", "l366"] }],
    junctions: [{ id: "j696", name: "J696", outline: [{ x: 28, y: -4 }, { x: 42, y: -4 }, { x: 42, y: 8 }], lights: { green: 18, amber: 3, allRed: 2, mode: "each", minGreen: 6, actuated: false, phases: [{ green: 20, conns: ["c-t148-1"] }] } }],
    crossings: [{ id: "z-t148-1", a: { x: 10, y: -3 }, b: { x: 10, y: 7 }, width: 3, peds: 30 }],
    traffic: { rate: 20, speed: 50, seed: 1 }, geo,
  };
  const wcheck = (patch: object, on = withWindow) => checkPatch(JSON.stringify(patch), on);
  const mainOf = (sk: object) => JSON.stringify({ ...sk, scratch: undefined });

  await t("window: a piece alone goes beside the window's content, fresh ids, its zebra too; the main plan unchanged", () => {
    const r = wcheck({ sketchWindowAdd: piece });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
    const s = r.ok ? r.summary : null!, w = s.window!, sc = s.sketch.scratch!;
    assert.equal(mainOf(s.sketch), mainOf(withWindow));
    assert.equal(s.items.length, 0);
    assert.equal(s.same, false);
    assert.ok(!s.fields.some(f => f.field === "scratch"), "told in its own section");
    assert.deepEqual(w.counts, { lanes: 2, connectors: 1, roads: 1, junctions: 1, crossings: 1, zones: 0 });
    // (ids remapped against the window's: l1, c1, r1, x1 are taken)
    assert.deepEqual(w.added, { lanes: ["l3", "l4"], connectors: ["c2"], junctions: ["j1"], crossings: ["x2"] });
    assert.deepEqual(sc.lanes.map(l => l.id), ["l1", "l2", "l3", "l4"]);
    assert.deepEqual(sc.roads.map(x => x.id), ["r1", "r2"]);
    assert.deepEqual(sc.junctions[0].lights?.phases?.[0].conns, ["c2"]);
    // (it would lie over the window's lanes (0..90 m): moved east, 20 m clear of them)
    assert.equal(w.beside, 110);
    const l3 = sc.lanes.find(l => l.id === "l3")!.shape;
    assert.deepEqual(l3.kind === "line" && l3.pts[0], { x: 110, y: 2 });
    assert.deepEqual(sc.crossings!.map(x => [x.id, x.a.x]), [["x1", 20], ["x2", 120]]);
    // (the window's own traffic and place kept; the window's content as it was)
    assert.deepEqual(sc.traffic, { rate: 10, speed: 40, seed: 2 });
    assert.deepEqual(sc.geo, geo);
    assert.deepEqual(sc.lanes.slice(0, 2), withWindow.scratch!.lanes);
  });

  await t("window: into an empty window at its own place, with the piece's traffic; the plan's geo puts it where it is", () => {
    const r = wcheck({ sketchWindowAdd: { ...piece, geo: { lat: geo.lat, lon: geo.lon + 0.001 } } }, rc);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
    const w = r.ok ? r.summary.window! : null!, sc = r.ok ? r.summary.sketch.scratch! : null!;
    assert.equal(w.empty, true);
    assert.equal(w.beside, 0);
    assert.deepEqual(w.added.lanes, ["l1", "l2"]);
    assert.deepEqual(sc.traffic, { rate: 20, speed: 50, seed: 1 });
    // (the plan has no geo here: nothing to shift by)
    const sh = sc.lanes[0].shape;
    assert.deepEqual(sh.kind === "line" && sh.pts[0], { x: 0, y: 2 });
    const r2 = wcheck({ sketchWindowAdd: { ...piece, geo: { lat: geo.lat, lon: geo.lon + 0.001 } } }, sanitizeSketch({ ...rich, geo })!);
    const sh2 = r2.ok ? r2.summary.sketch.scratch!.lanes[0].shape : null;
    assert.ok(sh2?.kind === "line" && Math.abs(sh2.pts[0].x - 75.8) < 0.1, "0.001° of longitude east at 47.13° N is about 75.8 m");
  });

  await t("window: with main items too, both done in one; the note says so", () => {
    const r = wcheck({ lanes: [{ id: "a", width: 5 }], sketchWindowAdd: piece });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
    const s = r.ok ? r.summary : null!;
    assert.deepEqual(s.items.map(x => [x.id, x.change]), [["a", "changed"]]);
    assert.equal(s.sketch.lanes.find(l => l.id === "a")!.width, 5);
    assert.equal(s.sketch.scratch!.lanes.length, 4);
    assert.equal(patchNote({ id: 9, task: "T148", author: "Bob", title: "J696 v1", patch: { sketchWindowAdd: piece } }), "Agent patch #9 (T148, Bob): J696 v1 (Sketch window)");
    assert.equal(patchNote({ id: 9, task: "T148", author: "Bob", title: "J696 v1", patch: { lanes: [{ id: "a", width: 5 }], sketchWindowAdd: piece } }), "Agent patch #9 (T148, Bob): J696 v1 (plan and Sketch window)");
  });

  await t("window: a piece that isn't a usable sketch is refused", () => {
    const no = (p: unknown) => { const r = wcheck({ sketchWindowAdd: p }); assert.equal(r.ok, false); return r.ok ? "" : r.errors.join("; "); };
    assert.match(no({ lanes: [] }), /isn't a usable sketch/);
    assert.match(no({ lanes: [{ id: "l1", width: 3 }], connectors: [] }), /isn't a usable sketch/);
    // (not an object: no patch at all)
    assert.match(no([piece]), /no sketch items/);
  });

  await t("window: a plain file (History's Apply changes from file) can't add to it; nor the page's own action on the server", async () => {
    const r = readSketchFile(JSON.stringify({ sketchWindowAdd: piece }), "apply", withWindow);
    assert.match(r.ok ? "" : r.error, /only agent patches may/);
    const m = { saves: [] as Saved[] };
    const d: RestoreFileDeps = {
      canEdit: true,
      current: async () => ({ engine: "v2", network: { nodes: [] }, settings: {}, underlay: null, sketch: { ...rich, geo, scratch: windowNow } }),
      save: async s => { m.saves.push(s); return { ok: true, revision: 8, savedAt: "" } as SaveResult; },
    };
    assert.equal((await restoreFromFile({ mode: "apply", file: { sketchWindowAdd: piece }, revision: 7 }, d)).ok, false);
    assert.equal(m.saves.length, 0);
    const ok3 = await restoreFromFile({ mode: "apply", file: { sketchWindowAdd: piece }, revision: 7, patch: { note: "Agent patch #9 (T148, Bob): J696 v1 (Sketch window)" } }, d);
    assert.deepEqual(ok3, { ok: true, revision: 8 });
    assert.equal(m.saves.length, 1);
    assert.equal(mainOf(m.saves[0].sketch), mainOf(withWindow));
    assert.equal(m.saves[0].sketch.scratch!.lanes.length, 4);
    assert.deepEqual(m.saves[0].restore, { note: "Agent patch #9 (T148, Bob): J696 v1 (Sketch window)", kind: "patch" });
  });

  console.log(`agent-patch: ${ok} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
