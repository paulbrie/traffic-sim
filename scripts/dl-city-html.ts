/**
 * Builds the experiment's page (ticket #277): one HTML file with everything in it, the app (city generator, V2
 * simulation, neural networks, searches, charts; src/lib/experiments/dl-city/page.ts, bundled) and every run recorded.
 *
 *   npx tsx scripts/dl-city-html.ts [--runs docs/experiments/dl-city-277/runs.jsonl] [--out docs/experiments/dl-city-277/index.html]
 *
 * It bundles the engine of the checkout it runs in. The runs in docs/experiments/dl-city-277 are the engine's at commit
 * 870a5ed: build the page there (a worktree at 870a5ed with these files in it) for "Simulate it here" to match them exactly.
 */
import { build } from "esbuild";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = arg("runs", join(root, "docs/experiments/dl-city-277/runs.jsonl")), OUT = arg("out", join(root, "docs/experiments/dl-city-277/index.html"));
const dir = join(root, "src/lib/experiments/dl-city");

async function main() {
  const js = await build({ entryPoints: [join(dir, "page.ts")], bundle: true, format: "iife", platform: "browser", target: "es2022", minify: !process.env.NOMIN, write: false, tsconfig: join(root, "tsconfig.json"), legalComments: "none" });
  const app = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const runs = readFileSync(RUNS, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  let commit = "uncommitted";
  try { commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); } catch { /* not a checkout */ }
  const data = JSON.stringify({ runs, city: 1, built: new Date().toISOString().slice(0, 10), commit }).replace(/</g, "\\u003c");
  const part = (name: string) => { try { return readFileSync(join(dir, `page-${name}.html`), "utf8"); } catch { return ""; } };
  const html = readFileSync(join(dir, "page.html"), "utf8")
    .replace("<!--FINDINGS-->", () => part("findings")).replace("<!--METHOD-->", () => part("method"))
    .replace("<!--DATA-->", () => data).replace("<!--APP-->", () => app);
  writeFileSync(OUT, html);
  console.log(`${OUT}: ${(html.length / 1024).toFixed(0)} KB (app ${(app.length / 1024).toFixed(0)} KB, ${runs.length} runs)`);
}
main().catch(e => { console.error(e); process.exit(1); });
