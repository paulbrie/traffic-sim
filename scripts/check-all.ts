/**
 * Every check at once: each `*:check` script in package.json, `engine:baseline` and `audit`, a few side by side, then what
 * passed and failed and how long each took; exits 1 if any failed (its output printed).
 *   npm test                      all of them, 4 at a time
 *   npm test -- -j 8              8 at a time (each one a Node process of up to ~1 GB)
 *   npm test -- ring explain      only those whose name contains one of the words
 * The checks need no database and no network (osm:check reads its Overpass answer from scripts/fixtures). The shell's
 * DATABASE_URL (the admin's) is left out of their environment so nothing can reach it by mistake.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const args = process.argv.slice(2);
const jAt = args.indexOf("-j"), jobs = jAt >= 0 ? Math.max(1, Number(args[jAt + 1]) || 1) : 4;
const words = args.filter((_, i) => jAt < 0 || (i !== jAt && i !== jAt + 1));
const names = Object.keys(scripts)
  .filter(n => n.endsWith(":check") || n === "engine:baseline" || n === "audit")
  .filter(n => !words.length || words.some(w => n.includes(w)));
if (!names.length) { console.error(`no check matches ${words.join(", ")}`); process.exit(1); }

type Done = { name: string; ok: boolean; s: number; out: string };
const env = { ...process.env };
delete env.DATABASE_URL;

function run(name: string): Promise<Done> {
  const t0 = Date.now();
  return new Promise(resolve => {
    // (`npm run` would print its own banner; the script's command run directly, through the local tsx)
    const [cmd, ...rest] = scripts[name].split(" ");
    const p = spawn(join(root, "node_modules/.bin", cmd), rest, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (out += d));
    p.on("close", code => resolve({ name, ok: code === 0, s: (Date.now() - t0) / 1000, out }));
  });
}

async function main() {
  const t0 = Date.now(), queue = [...names], done: Done[] = [];
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const r = await run(name);
      done.push(r);
      console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(22)} ${r.s.toFixed(1).padStart(6)} s`);
    }
  }));
  const failed = done.filter(r => !r.ok);
  for (const r of failed) console.log(`\n──── ${r.name} ────\n${r.out.trimEnd().split("\n").slice(-40).join("\n")}`);
  console.log(`\n${done.length - failed.length} of ${done.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s${failed.length ? `; failed: ${failed.map(r => r.name).join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
main();
