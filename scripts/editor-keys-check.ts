// The plan editor's keys wherever the focus is (T157b): which keys pressed outside the editor go to it.
import { strict as assert } from "node:assert";
import { keyForEditor } from "../src/lib/editor-keys";

let ok = 0;
const t = (name: string, f: () => void) => { f(); ok++; console.log(`ok  ${name}`); };
const btn = { tag: "BUTTON" }, radio = { tag: "BUTTON", role: "radio" }, sel = { tag: "SELECT" }, combo = { tag: "BUTTON", role: "combobox" };

t("nowhere in particular (the page's body): every key but Tab", () => {
  for (const k of ["Escape", "v", "l", "Delete", " ", "Enter"]) assert.equal(keyForEditor(k, false, null, false), true, k);
  assert.equal(keyForEditor("z", true, null, false), true);
  assert.equal(keyForEditor("Tab", false, null, false), false);
});
t("typing stays where it is: text inputs, text areas, editable text, search boxes", () => {
  for (const tg of [{ tag: "INPUT", type: "text" }, { tag: "INPUT", type: "number" }, { tag: "TEXTAREA" }, { tag: "DIV", editable: true }, { tag: "INPUT", role: "combobox", type: "text" }])
    for (const k of ["Escape", "v", "z"]) assert.equal(keyForEditor(k, k === "z", tg, false), false, `${tg.tag} ${k}`);
});
t("a focused button, switch or select trigger keeps Enter, Space and the arrows; Esc, letters and ⌘Z go to the editor", () => {
  for (const tg of [btn, radio, combo, { tag: "INPUT", type: "checkbox" }]) {
    for (const k of ["Enter", " ", "ArrowLeft", "ArrowDown"]) assert.equal(keyForEditor(k, false, tg, false), false, `${tg.tag} ${k}`);
    for (const k of ["Escape", "v", "c"]) assert.equal(keyForEditor(k, false, tg, false), true, `${tg.tag} ${k}`);
    assert.equal(keyForEditor("z", true, tg, false), true);
  }
});
t("a native select keeps its letters; Esc and ⌘ shortcuts go to the editor", () => {
  assert.equal(keyForEditor("v", false, sel, false), false);
  assert.equal(keyForEditor("Escape", false, sel, false), true);
  assert.equal(keyForEditor("z", true, sel, false), true);
});
t("an open menu, list or dialog has the keys", () => {
  for (const tg of [null, btn]) assert.equal(keyForEditor("Escape", false, tg, true), false);
});
console.log(`editor-keys: ${ok} checks passed`);
