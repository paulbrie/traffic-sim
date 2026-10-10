// History's file actions ("Restore from file", "Apply changes from file"): reading a sketch file, its summary
// against the current revision, and the server's decisions (access, V2 only, the revision it was compared
// with, the note, the merge on the stored sketch), with the data layer mocked.
import { strict as assert } from "node:assert";
import { applyPatch, leftOutCount, nothingToSave, readSketchFile, type FileSummary } from "../src/lib/sketch-diff";
import { restoreFromFile, restoreNote, type RestoreFileDeps } from "../src/server/restore-file";
import { sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import type { SaveResult } from "../src/server/data/plans";

const line = (id: string, x0: number, x1: number, y = 0) => ({ id, shape: { kind: "line", pts: [{ x: x0, y }, { x: x1, y }] }, width: 3.5 });
const base = {
  lanes: [line("a", 0, 50), line("b", 60, 120), line("c", 0, -50)],
  connectors: [{ id: "k1", from: { lane: "a", s: 50 }, to: { lane: "b", s: 0 } }],
  roads: [{ id: "r1", name: "Main", lanes: ["a", "b"] }],
  junctions: [{ id: "j1", name: "J", outline: [{ x: 50, y: -5 }, { x: 60, y: -5 }, { x: 60, y: 5 }] }],
  crossings: [{ id: "x1", a: { x: 20, y: -4 }, b: { x: 20, y: 4 }, width: 4, peds: 300 }],
  journeys: [{ id: "t1", from: "a", to: "b", rate: 100 }],
  geo: { lat: 47.13, lon: 24.49 },
  traffic: { rate: 600, speed: 50 },
  scratch: { lanes: [line("s1", 0, 20)] },
};
const cur = sanitizeSketch(base)!;
const summary = (text: string, mode: "restore" | "apply", c: Sketch | null = cur): FileSummary => {
  const r = readSketchFile(text, mode, c);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.summary;
};
let ok = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); ok++; console.log(`ok  ${name}`); };

type Saved = Parameters<RestoreFileDeps["save"]>[0];
function deps(over: Partial<RestoreFileDeps> & { engine?: string; stored?: number; sketch?: unknown } = {}) {
  const saves: Saved[] = [];
  let reads = 0;
  const d: RestoreFileDeps = {
    canEdit: true,
    current: async () => { reads++; return { engine: over.engine ?? "v2", network: { nodes: [] }, settings: { s: 1 }, underlay: null, sketch: over.sketch ?? base }; },
    // the save path's optimistic concurrency: only from the stored revision
    save: async s => { saves.push(s); const at = over.stored ?? 7; return (s.revision === at ? { ok: true, revision: at + 1, savedAt: "" } : { ok: false, reason: "conflict", revision: at }) as SaveResult; },
    ...over,
  };
  return { d, saves, reads: () => reads };
}

async function main() {
  // ---- restore: a whole sketch
  await t("restore: a bare sketch and one under `sketch`, the same result", () => {
    const a = summary(JSON.stringify({ ...base, lanes: [...base.lanes, line("e", 200, 260)] }), "restore");
    const b = summary(JSON.stringify({ revision: 3, sketch: { ...base, lanes: [...base.lanes, line("e", 200, 260)] } }), "restore");
    assert.deepEqual(a, b);
    assert.deepEqual(a.kinds.lanes, { added: ["e"], removed: [], changed: [] });
    assert.equal(a.same, false);
    assert.equal(summary(JSON.stringify(base), "restore").same, true);
  });

  await t("refuses what isn't a sketch", () => {
    for (const [text, mode, msg] of [["{oops", "restore", /valid JSON/], ["[1,2]", "apply", /no sketch items/], ['{"network":{}}', "restore", /no sketch items/],
      ['{"lanes":[{"id":"a"}]}', "restore", /no usable lanes/], ['{"connectors":[{"id":"k9"}]}', "restore", /whole V2 sketch/], ['{"lanes":[{"x":1}]}', "apply", /no sketch items/]] as const) {
      const r = readSketchFile(text, mode, cur);
      assert.equal(r.ok, false, text);
      assert.match(r.ok ? "" : r.error, msg);
    }
  });

  await t("restore: every top-level field the file lacks is kept, and said so (T69)", () => {
    // as the editor's Copy JSON: no geo, traffic, journeys or scratch; lane b moved
    const { scratch: _s, journeys: _j, geo: _g, traffic: _t, crossings: _c, ...copy } = base;
    const s = summary(JSON.stringify({ ...copy, lanes: [line("a", 0, 50), line("b", 62, 120), line("c", 0, -50)] }), "restore");
    assert.deepEqual([s.sketch.geo, s.sketch.traffic, s.sketch.journeys, s.sketch.scratch, s.sketch.crossings], [cur.geo, cur.traffic, cur.journeys, cur.scratch, cur.crossings]);
    assert.deepEqual(s.fields, ["crossings", "geo", "journeys", "scratch", "traffic"].map(field => ({ field, change: "kept from the current version" })));
    assert.deepEqual(s.kinds.lanes, { added: [], removed: [], changed: ["b"] });
    assert.equal(s.geo || s.traffic, false);
    for (const k of ["connectors", "roads", "junctions", "crossings"] as const) assert.deepEqual(s.kinds[k].removed, [], k);
    // nothing else changes: the same file as the plan is "the same"
    assert.equal(summary(JSON.stringify(copy), "restore").same, true);
  });

  await t("restore: only a field present in the file replaces; one it empties is cleared (red)", () => {
    const s = summary(JSON.stringify({ ...base, journeys: [], geo: { lat: 47, lon: 24 } }), "restore");
    assert.deepEqual(s.fields, [{ field: "geo", change: "differs" }, { field: "journeys", change: "cleared by the file" }]);
    assert.equal(s.sketch.journeys, undefined);
    assert.equal(s.geo, true);
  });

  await t("restore: reports what the server's checks leave out", () => {
    const s = summary(JSON.stringify({ ...base, lanes: [...base.lanes, { id: "bad", shape: { kind: "line", pts: [] } }], connectors: [...base.connectors, { id: "k2", from: { lane: "nope", s: 0 }, to: { lane: "a", s: 0 } }] }), "restore");
    assert.deepEqual(s.dropped, { lanes: 1, connectors: 1 });
  });

  // ---- apply: some items
  await t("apply: changes by id, adds new ones, removes nothing, keeps everything else", () => {
    // as captured from the sim: derived fields too, which the checks drop
    const b2 = { ...line("b", 60, 120), shape: { kind: "line", pts: [{ x: 60, y: 0 }, { x: 80, y: 2 }, { x: 100, y: 2 }, { x: 120, y: 0 }] }, len: 60.2, poly: [1, 2] };
    const s = summary(JSON.stringify({ lanes: [b2, line("e", 200, 260), line("a", 0, 50)] }), "apply");
    assert.deepEqual(s.items, [
      { kind: "lanes", id: "b", change: "changed", before: "2 points", after: "4 points", fields: ["shape"] },
      { kind: "lanes", id: "e", change: "added", after: "2 points" },
      { kind: "lanes", id: "a", change: "unchanged", before: "2 points", after: "2 points" },
    ]);
    assert.deepEqual(s.kinds.lanes, { added: ["e"], removed: [], changed: ["b"] });
    for (const k of ["connectors", "roads", "junctions", "crossings"] as const) assert.deepEqual(s.kinds[k], { added: [], removed: [], changed: [] }, k);
    assert.deepEqual(s.fields, []);
    assert.equal(s.geo || s.traffic, false);
    assert.deepEqual([s.sketch.scratch, s.sketch.journeys, s.sketch.traffic, s.sketch.geo], [cur.scratch, cur.journeys, cur.traffic, cur.geo]);
    assert.equal("len" in s.sketch.lanes.find(l => l.id === "b")!, false);
  });

  await t("apply: a connector or junction alone, against the current lanes", () => {
    const s = summary(JSON.stringify({ sketch: { connectors: [{ id: "k1", from: { lane: "a", s: 50 }, to: { lane: "b", s: 0 }, via: [{ x: 55, y: 1 }] }], junctions: [{ id: "j1", name: "J", outline: [{ x: 50, y: -5 }, { x: 60, y: -5 }, { x: 60, y: 5 }, { x: 50, y: 5 }] }] } }), "apply");
    assert.deepEqual(s.items.map(x => [x.id, x.change, x.before, x.after]), [["k1", "changed", "0 bend points", "1 bend points"], ["j1", "changed", "3 outline points", "4 outline points"]]);
  });

  await t("apply: invalid items are left out and shown; the current one stays", () => {
    const s = summary(JSON.stringify({ lanes: [{ id: "b", shape: { kind: "line", pts: [] } }, { id: "z", shape: { kind: "line", pts: [] } }, line("e", 200, 260)] }), "apply");
    assert.deepEqual(s.items, [
      { kind: "lanes", id: "b", change: "left out (invalid; the current one stays)", before: "2 points", after: "2 points" },
      { kind: "lanes", id: "z", change: "left out (invalid)", why: "a new item must have all its fields" },
      { kind: "lanes", id: "e", change: "added", after: "2 points" },
    ]);
    assert.deepEqual(s.dropped, { lanes: 2 });
    // nothing removed: lane b, its connector and its road as they were
    for (const k of ["lanes", "connectors", "roads"] as const) assert.deepEqual(s.kinds[k].removed, [], k);
    assert.deepEqual(s.kinds.lanes.added, ["e"]);
  });

  // ---- apply: partial items, field by field (T88)
  await t("apply: an item with only some fields changes those (T72's {id, width})", () => {
    const s = summary(JSON.stringify({ lanes: [{ id: "b", width: 5 }] }), "apply");
    assert.deepEqual(s.items, [{ kind: "lanes", id: "b", change: "changed", before: "2 points", after: "2 points", fields: ["width"] }]);
    assert.equal(s.same, false);
    assert.deepEqual(s.kinds.lanes, { added: [], removed: [], changed: ["b"] });
    const b = s.sketch.lanes.find(l => l.id === "b")!;
    assert.deepEqual([b.width, b.shape], [5, cur.lanes.find(l => l.id === "b")!.shape]);
    assert.deepEqual(s.dropped, {});
  });

  await t("apply: a field the file lacks is kept; null clears an optional one", () => {
    const c2 = sanitizeSketch({ ...base, lanes: [{ ...line("a", 0, 50), control: "stop", inRate: 300 }, line("b", 60, 120), line("c", 0, -50)] })!;
    const kept = summary(JSON.stringify({ lanes: [{ id: "a", width: 4 }] }), "apply", c2).sketch.lanes[0];
    assert.deepEqual([kept.width, kept.control, kept.inRate], [4, "stop", 300]);
    const s = summary(JSON.stringify({ lanes: [{ id: "a", control: null }] }), "apply", c2);
    assert.deepEqual(s.items.map(x => [x.change, x.fields]), [["changed", ["control"]]]);
    assert.equal("control" in s.sketch.lanes[0], false);
    assert.equal(s.sketch.lanes[0].inRate, 300);
  });

  await t("apply: null on a required field is refused and says which; the current item stays", () => {
    const s = summary(JSON.stringify({ lanes: [{ id: "a", shape: null, width: 5 }], connectors: [{ id: "k1", from: null }] }), "apply");
    assert.deepEqual(s.items.map(x => [x.id, x.change, x.why]), [
      ["a", "left out (invalid; the current one stays)", "shape can't be cleared"],
      ["k1", "left out (invalid; the current one stays)", "from can't be cleared"],
    ]);
    assert.equal(s.same, true);
    assert.deepEqual(s.sketch.lanes.find(l => l.id === "a"), cur.lanes.find(l => l.id === "a"));
    assert.deepEqual(s.dropped, { lanes: 1, connectors: 1 });
  });

  await t("apply: a new id needs a whole item", () => {
    const s = summary(JSON.stringify({ lanes: [{ id: "z", width: 4 }, line("e", 200, 260)] }), "apply");
    assert.deepEqual(s.items.map(x => [x.id, x.change, x.why]), [["z", "left out (invalid)", "a new item must have all its fields"], ["e", "added", undefined]]);
    assert.deepEqual(s.kinds.lanes.added, ["e"]);
  });

  // ---- nothing would change, but items were left out: say so, with the reasons (T115)
  await t("apply: a file whose only items are refused says they were left out, not just 'nothing to save'", () => {
    const shapeNull = summary(JSON.stringify({ lanes: [{ id: "a", shape: null }] }), "apply");
    assert.equal(shapeNull.same, true);
    assert.equal(leftOutCount(shapeNull), 1);
    assert.equal(nothingToSave(shapeNull), "Nothing would change: 1 item was left out (see why below).");
    assert.equal(shapeNull.items[0].why, "shape can't be cleared");
    const newPartial = summary(JSON.stringify({ lanes: [{ id: "l99", width: 4 }, { id: "z", width: 3 }] }), "apply");
    assert.equal(nothingToSave(newPartial), "Nothing would change: 2 items were left out (see why below).");
    assert.deepEqual(newPartial.items.map(x => x.why), ["a new item must have all its fields", "a new item must have all its fields"]);
    // unchanged and nothing refused: the plain message; a real change: none
    assert.equal(nothingToSave(summary(JSON.stringify({ lanes: [line("a", 0, 50)] }), "apply")), "The result is the same as the current version: nothing to save.");
    assert.equal(nothingToSave(summary(JSON.stringify({ lanes: [{ id: "a", width: 5 }] }), "apply")), null);
  });

  await t("restore: invalid items left out of an otherwise identical file are counted too", () => {
    const s = summary(JSON.stringify({ ...base, lanes: [...base.lanes, { id: "bad", shape: { kind: "line", pts: [] } }] }), "restore");
    assert.equal(s.same, true);
    assert.equal(nothingToSave(s), "Nothing would change: 1 item was left out (see why below).");
  });

  await t("apply: compared with the plan as it is now, not as it was (T115: a save in between)", () => {
    // the dialog reads the stored state each time (fetchPlanState); against the newer one the same file reads differently
    const before = sanitizeSketch({ ...base, lanes: [{ ...line("a", 0, 50), width: 5 }, line("b", 60, 120), line("c", 0, -50)] })!;
    const after = sanitizeSketch({ ...base, lanes: [{ ...line("a", 0, 50), width: 4 }, line("b", 60, 120), line("c", 0, -50)] })!;
    const file = JSON.stringify({ lanes: [{ id: "a", width: 5 }] });
    assert.equal(summary(file, "apply", before).same, true);
    assert.deepEqual(summary(file, "apply", after).items.map(x => [x.change, x.fields]), [["changed", ["width"]]]);
  });

  await t("apply: nothing new is 'the same'", () => {
    assert.equal(summary(JSON.stringify({ lanes: [line("a", 0, 50)] }), "apply").same, true);
    assert.equal(applyPatch(cur, { lanes: [line("a", 0, 50)] })!.lanes.length, 3);
  });

  // ---- the server's decisions, the data layer mocked
  const restoreFile = { ...base, lanes: [...base.lanes, line("e", 200, 260)] };

  await t("only someone who may save the plan", async () => {
    const m = deps({ canEdit: false });
    for (const mode of ["restore", "apply"] as const) assert.deepEqual(await restoreFromFile({ mode, file: restoreFile, revision: 7 }, m.d), { ok: false, error: "You can't change this plan." });
    assert.equal(m.saves.length + m.reads(), 0);
  });

  await t("V2 plans only", async () => {
    const m = deps({ engine: "v1" });
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [line("e", 200, 260)] }, revision: 7 }, m.d);
    assert.match(r.ok ? "" : r.error, /Only V2/);
    assert.equal(m.saves.length, 0);
  });

  await t("a bad file, mode or revision never reaches the database", async () => {
    for (const input of [{ mode: "restore", file: { lanes: [] }, revision: 7 }, { mode: "apply", file: "x", revision: 7 }, { mode: "apply", file: { lanes: [{ x: 1 }] }, revision: 7 },
      { mode: "restore", file: { connectors: [{ id: "k" }] }, revision: 7 }, { mode: "wipe", file: restoreFile, revision: 7 }, { mode: "restore", file: restoreFile, revision: -1 }, { mode: "restore", file: restoreFile, revision: 1.5 }]) {
      const m = deps();
      const r = await restoreFromFile(input as never, m.d);
      assert.equal(r.ok, false, JSON.stringify(input));
      assert.equal(m.saves.length + m.reads(), 0, JSON.stringify(input));
    }
  });

  await t("restore: saved from the revision it was compared with, as a restore with the note", async () => {
    const m = deps();
    const r = await restoreFromFile({ mode: "restore", file: restoreFile, revision: 7, note: "  Bob's fix\nfor J1 ", fileName: "bistrita-fix.json" }, m.d);
    assert.deepEqual(r, { ok: true, revision: 8 });
    const s = m.saves[0];
    assert.equal(s.revision, 7);
    assert.deepEqual(s.restore, { note: "Restored from the file bistrita-fix.json: Bob's fix for J1", kind: "restore" });
    assert.deepEqual(s.sketch.lanes.map(l => l.id), ["a", "b", "c", "e"]);
    assert.deepEqual([s.network, s.settings, s.underlay], [{ nodes: [] }, { s: 1 }, null]);
  });

  await t("apply: merged on the stored sketch (not the client's), everything else kept", async () => {
    const stored = { ...base, lanes: [...base.lanes, line("f", 300, 360)] };
    const m = deps({ sketch: stored });
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [line("b", 60, 130)] }, revision: 7, fileName: "patch.json" }, m.d);
    assert.equal(r.ok, true);
    const s = m.saves[0].sketch;
    assert.deepEqual(s.lanes.map(l => l.id), ["a", "b", "c", "f"]);
    assert.deepEqual(s.lanes[1].shape, { kind: "line", pts: [{ x: 60, y: 0 }, { x: 130, y: 0 }] });
    assert.deepEqual([s.scratch, s.journeys, s.connectors, s.roads], [cur.scratch, cur.journeys, cur.connectors, cur.roads]);
    // recorded as an apply, not a restore (History: "Applied from file", T69)
    assert.deepEqual(m.saves[0].restore, { note: "Applied changes from the file patch.json", kind: "apply" });
  });

  await t("apply on the server: an item's own fields merged onto the stored one (T88)", async () => {
    const m = deps();
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [{ id: "b", width: 5 }] }, revision: 7 }, m.d);
    assert.equal(r.ok, true);
    const b = m.saves[0].sketch.lanes.find(l => l.id === "b")!;
    assert.deepEqual([b.width, b.shape], [5, cur.lanes.find(l => l.id === "b")!.shape]);
    assert.deepEqual(m.saves[0].sketch.connectors, cur.connectors);
  });

  await t("restore on the server keeps what the file lacks, from the stored sketch", async () => {
    const { geo: _g, traffic: _t, journeys: _j, ...copy } = base;
    const m = deps();
    await restoreFromFile({ mode: "restore", file: copy, revision: 7 }, m.d);
    const s = m.saves[0].sketch;
    assert.deepEqual([s.geo, s.traffic, s.journeys], [cur.geo, cur.traffic, cur.journeys]);
  });

  await t("someone saved in between: refused, with the new revision", async () => {
    const m = deps({ stored: 9 });
    const r = await restoreFromFile({ mode: "apply", file: { lanes: [line("e", 200, 260)] }, revision: 7 }, m.d);
    assert.equal(r.ok ? 0 : r.revision, 9);
    assert.match(r.ok ? "" : r.error, /someone else/);
  });

  await t("restore keeps the plan's Sketch-window ideas when the file has none", async () => {
    const { scratch: _s, ...noScratch } = base;
    const m = deps();
    await restoreFromFile({ mode: "restore", file: noScratch, revision: 7 }, m.d);
    assert.deepEqual(m.saves[0].sketch.scratch, cur.scratch);
    const own = { lanes: [line("s2", 0, 30)] };
    const m2 = deps();
    await restoreFromFile({ mode: "restore", file: { ...base, scratch: own }, revision: 7 }, m2.d);
    assert.deepEqual(m2.saves[0].sketch.scratch!.lanes.map(l => l.id), ["s2"]);
  });

  await t("the note: what, which file, own note trimmed and capped", () => {
    assert.equal(restoreNote("restore", undefined, ""), "Restored from a file");
    assert.equal(restoreNote("apply", "a.json", 42), "Applied changes from the file a.json");
    assert.ok(restoreNote("apply", "a.json", "x".repeat(5000)).length <= 660);
  });

  await t("speed limits kept through sanitizing (a road's, a lane's in no road), clamped to 10-130 km/h; none kept as none", () => {
    const sk = sanitizeSketch({ lanes: [line("a", 0, 50), { ...line("b", 0, 50, 10), speed: 30 }, { ...line("c", 0, 50, 20), speed: 500 }], connectors: [], junctions: [],
      roads: [{ id: "r1", name: "Main", lanes: ["a"], speed: 70 }, { id: "r2", name: "Side", lanes: ["c"], speed: 3 }] })!;
    const again = sanitizeSketch(JSON.parse(JSON.stringify(sk)))!;
    for (const x of [sk, again]) {
      assert.equal(x.roads.find(r => r.id === "r1")!.speed, 70);
      assert.equal(x.roads.find(r => r.id === "r2")!.speed, 10);
      assert.equal(x.lanes.find(l => l.id === "b")!.speed, 30);
      assert.equal(x.lanes.find(l => l.id === "c")!.speed, 130);
      assert.equal("speed" in x.lanes.find(l => l.id === "a")!, false);
    }
  });

  console.log(`restore-file: ${ok} checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
