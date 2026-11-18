/**
 * The page against Chrome's Modern Web Guidance (ticket #272): dark mode tells the browser (`color-scheme`), so its
 * own controls are dark too; Enter in a text field never acts on an input method's composing Enter; dialogs, menus
 * and tooltips zoom only when motion is fine with the user, and spinners slow down rather than spin fast. The
 * second half reads the source, so a new raw Enter handler or a zoom without motion-safe fails here. `npm run web:check`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEnter } from "../src/lib/enter-key";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};

// Enter, and an input method's Enter.
check("a plain Enter acts", isEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } }));
check("Enter confirming a composition (isComposing, React's nativeEvent) doesn't", !isEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }));
check("…nor a DOM event's isComposing", !isEnter({ key: "Enter", keyCode: 13, isComposing: true }));
check("…nor Safari's, composition already over but keyCode 229", !isEnter({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } }));
check("other keys don't", !isEnter({ key: "a", keyCode: 65 }) && !isEnter({ key: "Escape", keyCode: 27 }));

// The source.
const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap(f => {
  const p = join(dir, f);
  return statSync(join(ROOT, p)).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});
const src = files("src");

const css = read("src/app/globals.css"), root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
check("globals.css: :root says it has light and dark colours (color-scheme)", /color-scheme:\s*light dark/.test(root));
check("the root layout tells the browser before the CSS loads (viewport colorScheme)", /export const viewport[^=]*=\s*\{[^}]*colorScheme:\s*"light dark"/.test(read("src/app/layout.tsx")));

// (a key handler on a text field acting on e.key === "Enter": Cmd/Ctrl+Enter and a button's Enter or Space are fine)
const raw: string[] = [];
for (const p of src) read(p).split("\n").forEach((line, i) => {
  if (!/onKeyDown/.test(line) || !/\bkey === "Enter"/.test(line)) return;
  if (/metaKey|ctrlKey|key === " "/.test(line)) return;
  raw.push(`${p}:${i + 1}`);
});
check("no text field acts on a raw Enter (isEnter from lib/enter-key)", !raw.length, raw.join(", "));

const zoom: string[] = [];
for (const p of src.filter(p => p.startsWith("src/components/ui/"))) {
  for (const m of read(p).matchAll(/(\S*)\b(zoom-(?:in|out)-\d+|slide-(?:in|out)-(?:from|to)-\S+)/g)) if (!m[1].includes("motion-safe:")) zoom.push(`${p}: ${m[0]}`);
}
check("dialogs, menus and tooltips zoom or slide only under motion-safe (the fade stays)", !zoom.length, zoom.join(", "));
check("spinners slow down with reduced motion asked for", /\.animate-spin\s*\{\s*@media \(prefers-reduced-motion: reduce\)\s*\{\s*animation-duration:\s*\d+s/.test(css));
check("the V2 editor's view jumps rather than glides with reduced motion asked for", /prefers-reduced-motion: reduce\)"\)\.matches\) \{ view\.current = to;/.test(read("src/components/workspace/lane-sketch.tsx")));

for (const p of ["src/components/v2/sketch-search.tsx", "src/components/workspace/search-palette.tsx"]) {
  const s = read(p);
  check(`${p.split("/").pop()}: a combobox naming the row picked (aria-activedescendant), rows out of the Tab order`,
    /role="combobox"/.test(s) && /aria-activedescendant=/.test(s) && /aria-controls=\{listId\}/.test(s) && /role="option"[^>]*tabIndex=\{-1\}/.test(s));
}

console.log(ok ? "web check: all ok" : "web check: FAILED");
process.exit(ok ? 0 : 1);
