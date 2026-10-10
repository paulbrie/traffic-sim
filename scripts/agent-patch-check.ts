// Agent patches (T132): what a submit accepts and refuses, and applying one: one save through the same path as
// "Apply changes from file", noted "Agent patch #n (T56, Bob): title" and recorded as its own kind; a conflict
// refuses with the new revision; the page's own file action can't pass itself off as a patch.
import { strict as assert } from "node:assert";
import { checkPatch, patchNote, authorColor } from "../src/lib/agent-patch";
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

  console.log(`agent-patch: ${ok} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
