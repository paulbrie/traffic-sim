/**
 * Submits an agent patch (T132): a change an agent proposes to a plan, for its editors to apply or reject on the
 * plan's page ("Agent patches"). It never changes the plan.
 *   npm run patch:submit -- --plan <id> --author Bob --task T56 --title "…" --desc what-and-why.md --patch patch.json [--supersedes <n>]
 * The patch is what "Apply changes from file" takes, and may also remove items (`remove`) and add a piece to the
 * plan's Sketch window (`sketchWindowAdd`, see src/lib/agent-patch.ts). It is checked against the plan's current revision first:
 * refused (exit 1, with the reasons) if it isn't a patch, if the checks would leave any item out, or if nothing
 * would change; and for a plan that doesn't exist or isn't V2. --supersedes marks the author's older pending
 * patch on that plan superseded. Prints the new patch's #n and where to see it (the plan's path in the app;
 * with TRAFFICSIM_URL set, e.g. https://host/projects/trafficsim, a full link).
 * The database is trafficsim's, from .env.local (DATABASE_URL only), and must be `railway`.
 */
import { readFileSync } from "fs";
import postgres from "postgres";
import { sanitizeSketch } from "../src/lib/lane-sketch";
import { checkPatch, PATCH_DESC_MAX, PATCH_TITLE_MAX } from "../src/lib/agent-patch";

function args(): Record<string, string> {
  const a = process.argv.slice(2), out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) throw new Error(`unexpected "${a[i]}"`);
    const k = a[i].slice(2), v = a[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
    out[k] = v;
    i++;
  }
  return out;
}

async function main() {
  const o = args();
  for (const k of ["plan", "author", "title", "patch"]) if (!o[k]) throw new Error(`--${k} is required`);
  if (!/^[0-9a-f-]{36}$/i.test(o.plan)) throw new Error("--plan must be a plan id (uuid)");
  const title = o.title.replace(/\s+/g, " ").trim().slice(0, PATCH_TITLE_MAX), author = o.author.trim().slice(0, 60), task = (o.task ?? "").trim().slice(0, 20);
  const description = o.desc ? readFileSync(o.desc, "utf8").slice(0, PATCH_DESC_MAX) : "";
  const patchText = readFileSync(o.patch, "utf8");
  const supersedes = o.supersedes ? Number(o.supersedes.replace(/^#/, "")) : null;
  if (supersedes !== null && !Number.isInteger(supersedes)) throw new Error("--supersedes must be a patch number");

  const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(".env.local", "utf8"))?.[1].trim().replace(/^"|"$/g, "");
  if (!url) throw new Error("no DATABASE_URL in .env.local");
  const sql = postgres(url, { max: 1 });
  try {
    const [{ d }] = await sql`select current_database() as d`;
    if (d !== "railway") throw new Error(`database is ${d}, not railway: stop`);
    const [plan] = await sql`select id, name, engine, revision, sketch from plans where id = ${o.plan}`;
    if (!plan) throw new Error(`no plan ${o.plan}`);
    if (plan.engine !== "v2") throw new Error(`plan "${plan.name}" isn't a V2 plan: agent patches are for V2 plans`);
    const check = checkPatch(patchText, sanitizeSketch(plan.sketch), title);
    if (!check.ok) {
      console.error(`Refused: the patch doesn't apply cleanly to "${plan.name}" (rev. ${plan.revision}):\n` + check.errors.map((e) => `  - ${e}`).join("\n"));
      process.exitCode = 1;
      return;
    }
    const id = await sql.begin(async (tx) => {
      if (supersedes !== null) {
        const old = await tx`update agent_patches set status = 'superseded', decided_at = now() where id = ${supersedes} and plan_id = ${o.plan} and author = ${author} and status = 'pending' returning id`;
        if (!old.length) throw new Error(`#${supersedes} isn't a pending patch of ${author}'s on this plan`);
      }
      const [r] = await tx`insert into agent_patches (plan_id, author, task, title, description, patch, base_revision) values (${o.plan}, ${author}, ${task}, ${title}, ${description}, ${tx.json(check.payload as never)}, ${plan.revision}) returning id`;
      return r.id as number;
    });
    const s = check.summary, items = s.items.filter((x) => x.change !== "unchanged").length, w = s.window;
    const win = w ? `; adds ${w.counts.lanes} lane${w.counts.lanes === 1 ? "" : "s"} and ${w.counts.junctions} junction${w.counts.junctions === 1 ? "" : "s"} as a new sketch "${w.sketchName}" (the user's own sketches untouched)` : "";
    // (the app's address isn't the script's to guess: a shell may hold another app's base path; TRAFFICSIM_URL, if set, is put first)
    const where = `${(process.env.TRAFFICSIM_URL ?? "").replace(/\/$/, "")}/plans/${o.plan}`;
    console.log(`PATCH: #${id} submitted to "${plan.name}" (rev. ${plan.revision}): ${items} item${items === 1 ? "" : "s"} changed or added${win}${supersedes !== null ? `; #${supersedes} superseded` : ""}.`);
    console.log(`See it on the plan's page, "Agent patches": ${where}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
