/**
 * The Claude bridge's edit actions (T189, docs/claude-bridge.md): what an agent may change in a sketch editor (the plan's
 * or the Sketch window's), each a function from the sketch to the next one, its arguments checked strictly (as the
 * bridge's other actions, T59/T67: true or false, a number, a string, nothing taken for what it isn't). The page applies
 * the result through the editor's store, so it is one undo step and saves as a user's edit would; a `batch` of them is one
 * step. Framework-free (checked by `npm run engine:check`).
 */
import { DEFAULT_LIGHTS, LANE_WIDTH, LEVELS, contentsOf, groupRoad, laneById, laneLength, nextId, pointAt, remove, reshape, setControl, setLaneSpeed, setLevel, type LaneAt, type LaneShape, type Pt, type Sketch, type SketchConnector, type SketchLane } from "./lane-sketch";
import { deleteLanes } from "./road-lanes";
import { stampRoundabout } from "./roundabout";

/** what an edit did: the sketch after it, what to tell the agent, where on the map it was (the agent's cursor goes there), and a few words for the user */
export interface EditDone { sketch: Sketch; result: Record<string, unknown>; at: Pt | null; said: string }
type Args = Record<string, unknown>;
type Edit = (sk: Sketch, a: Args) => EditDone;

// ---------------------------------------------------------------- arguments, checked

const fail = (m: string): never => { throw new Error(m); };
const isObj = (v: unknown): v is Args => !!v && typeof v === "object" && !Array.isArray(v);
function num(a: Args, key: string, min: number, max: number, required: true): number;
function num(a: Args, key: string, min: number, max: number, required?: false): number | undefined;
function num(a: Args, key: string, min: number, max: number, required = false): number | undefined {
  const v = a[key];
  if (v === undefined) return required ? fail(`"${key}" is needed (a number from ${min} to ${max})`) : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`"${key}" must be a number, not ${JSON.stringify(v)}`);
  if (v < min || v > max) return fail(`"${key}" must be from ${min} to ${max}, not ${v}`);
  return v;
}
function str(a: Args, key: string, required: true): string;
function str(a: Args, key: string, required?: false): string | undefined;
function str(a: Args, key: string, required = false): string | undefined {
  const v = a[key];
  if (v === undefined) return required ? fail(`"${key}" is needed (a string)`) : undefined;
  if (typeof v !== "string" || !v.trim()) return fail(`"${key}" must be a string, not ${JSON.stringify(v)}`);
  return v;
}
const bool = (a: Args, key: string): boolean | undefined => {
  const v = a[key];
  if (v === undefined) return undefined;
  return typeof v === "boolean" ? v : fail(`"${key}" must be true or false, not ${JSON.stringify(v)}`);
};
/** a list of ids, each one there (`has`) */
function ids(a: Args, key: string, what: string, has: (id: string) => boolean): string[] {
  const v = a[key];
  if (!Array.isArray(v) || !v.length) return fail(`"${key}" is needed: a list of ${what} ids`);
  const out = v.map(x => (typeof x === "string" ? x : fail(`"${key}": ids are strings, not ${JSON.stringify(x)}`)));
  const missing = out.filter(id => !has(id));
  if (missing.length) fail(`no ${what} ${missing.join(", ")}`);
  return [...new Set(out)];
}
/** a point: { x, y } in metres, within 1,000 km of the plan's origin */
const pt = (v: unknown, where: string): Pt => {
  if (!isObj(v)) return fail(`${where}: a point { x, y } in metres`);
  return { x: num(v, "x", -1e6, 1e6, true), y: num(v, "y", -1e6, 1e6, true) };
};
/** a list of points, at least `min` */
function pts(a: Args, key: string, min: number, required: true): Pt[];
function pts(a: Args, key: string, min: number, required?: false): Pt[] | undefined;
function pts(a: Args, key: string, min: number, required = false): Pt[] | undefined {
  const v = a[key];
  if (v === undefined) return required ? fail(`"${key}" is needed: a list of at least ${min} points { x, y } (metres)`) : undefined;
  if (!Array.isArray(v) || v.length < min) return fail(`"${key}": a list of at least ${min} points { x, y } (metres)`);
  if (v.length > 500) fail(`"${key}": at most 500 points`);
  return v.map((p, i) => pt(p, `"${key}"[${i}]`));
}
const lane = (sk: Sketch, id: string): SketchLane => laneById(sk, id) ?? fail(`no lane ${id}`);
/** a place on a lane: { lane, s? } (`s` metres from its start; default `dflt`: its start or its end) */
const laneAt = (sk: Sketch, v: unknown, where: string, dflt: "start" | "end"): LaneAt => {
  if (!isObj(v)) return fail(`${where}: { lane, s? } (s: metres along it, default its ${dflt})`);
  const l = lane(sk, str(v, "lane", true)), L = laneLength(l.shape);
  const s = num(v, "s", 0, Math.round(L * 1000) / 1000) ?? (dflt === "end" ? L : 0);
  return { lane: l.id, s };
};
const near = (sk: Sketch, at: LaneAt) => { const l = laneById(sk, at.lane); return l ? pointAt(l.shape, at.s).p : null; };
const middle = (ps: Pt[]): Pt | null => (ps.length ? { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length } : null);
/** the keys an action takes: any other is an error (a typo would otherwise be quietly ignored) */
const only = (a: Args, keys: string[]) => { const bad = Object.keys(a).filter(k => !keys.includes(k)); if (bad.length) fail(`unknown ${bad.map(k => `"${k}"`).join(", ")}: this action takes ${keys.join(", ") || "nothing"}`); };

// ---------------------------------------------------------------- the edits

const EDITS: Record<string, Edit> = {
  // a lane through its points: { points, width?, speed? (km/h), level?, curved? (round through its middle points) }
  addLane(sk, a) {
    only(a, ["points", "width", "speed", "level", "curved"]);
    const ps = pts(a, "points", 2, true), width = num(a, "width", 2, 6) ?? LANE_WIDTH, speed = num(a, "speed", 5, 150), level = num(a, "level", LEVELS.min, LEVELS.max), curved = bool(a, "curved");
    if (!Number.isInteger(level ?? 0)) fail(`"level" must be a whole number`);
    if (ps.some((p, i) => i && Math.hypot(p.x - ps[i - 1].x, p.y - ps[i - 1].y) < 0.5)) fail(`"points": each at least 0.5 m from the one before`);
    const id = nextId("l", sk.lanes.map(l => l.id));
    const shape: LaneShape = { kind: "line", pts: ps, ...(curved ? { curved: ps.map((_, i) => i > 0 && i < ps.length - 1) } : {}) };
    let next: Sketch = { ...sk, lanes: [...sk.lanes, { id, shape, width }] };
    if (speed !== undefined) next = setLaneSpeed(next, id, speed);
    if (level) next = setLevel(next, [id], level);
    return { sketch: next, result: { lane: id, length: Math.round(laneLength(shape) * 10) / 10 }, at: ps[0], said: `added lane ${id}` };
  },
  // lanes deleted, with their connectors (a road left with none goes): { lanes }
  deleteLanes(sk, a) {
    only(a, ["lanes"]);
    const ls = ids(a, "lanes", "lane", id => !!laneById(sk, id)), at = near(sk, { lane: ls[0], s: 0 });
    const r = deleteLanes(sk, ls);
    return { sketch: r.sketch, result: { deleted: ls, roadsGone: r.roadsGone }, at, said: `deleted ${ls.length === 1 ? `lane ${ls[0]}` : `${ls.length} lanes`}` };
  },
  // a line lane's points all given again: { lane, points } (its connectors kept within its new length)
  reshapeLane(sk, a) {
    only(a, ["lane", "points"]);
    const l = lane(sk, str(a, "lane", true)), ps = pts(a, "points", 2, true), sh = l.shape;
    if (sh.kind !== "line") return fail(`lane ${l.id} is an arc: only line lanes are reshaped by points`);
    const curved = sh.curved && sh.curved.length === ps.length ? { curved: sh.curved } : {};
    const shape: LaneShape = { kind: "line", pts: ps, ...curved, ...(sh.closed ? { closed: true as const } : {}) };
    return { sketch: reshape(sk, l.id, shape), result: { lane: l.id, length: Math.round(laneLength(shape) * 10) / 10 }, at: ps[0], said: `reshaped lane ${l.id}` };
  },
  // one point of a line lane moved: { lane, i (from 0), x, y }
  movePoint(sk, a) {
    only(a, ["lane", "i", "x", "y"]);
    const l = lane(sk, str(a, "lane", true)), sh = l.shape;
    if (sh.kind !== "line") return fail(`lane ${l.id} is an arc: it has no points to move`);
    const i = num(a, "i", 0, sh.pts.length - 1, true);
    if (!Number.isInteger(i)) fail(`"i" must be a whole number (0 to ${sh.pts.length - 1})`);
    const p = { x: num(a, "x", -1e6, 1e6, true), y: num(a, "y", -1e6, 1e6, true) };
    const shape = { ...sh, pts: sh.pts.map((q, k) => (k === i ? p : q)) };
    return { sketch: reshape(sk, l.id, shape), result: { lane: l.id, i }, at: p, said: `moved point ${i} of lane ${l.id}` };
  },
  // a connector from one lane to another: { from: { lane, s? (default its end) }, to: { lane, s? (default its start) }, bends?, straight? }
  addConnector(sk, a) {
    only(a, ["from", "to", "bends", "straight"]);
    const from = laneAt(sk, a.from, `"from"`, "end"), to = laneAt(sk, a.to, `"to"`, "start"), via = pts(a, "bends", 1), straight = bool(a, "straight");
    if (from.lane === to.lane) fail(`"from" and "to" are the same lane: a connector joins two lanes`);
    if (sk.connectors.some(c => c.from.lane === from.lane && c.to.lane === to.lane && Math.abs(c.from.s - from.s) < 1 && Math.abs(c.to.s - to.s) < 1)) fail(`lane ${from.lane} is already joined to lane ${to.lane} there`);
    const id = nextId("c", sk.connectors.map(c => c.id));
    const c: SketchConnector = { id, from, to, ...(via?.length ? { via } : {}), ...(straight ? { straight: true as const } : {}) };
    const next = { ...sk, connectors: [...sk.connectors, c] };
    return { sketch: next, result: { connector: id, from, to }, at: near(sk, from), said: `added connector ${id} (${from.lane} → ${to.lane})` };
  },
  // connectors deleted: { connectors }
  deleteConnectors(sk, a) {
    only(a, ["connectors"]);
    const cs = ids(a, "connectors", "connector", id => sk.connectors.some(c => c.id === id)), first = sk.connectors.find(c => c.id === cs[0])!;
    return { sketch: remove(sk, { connectors: cs }), result: { deleted: cs }, at: near(sk, first.from), said: `deleted ${cs.length === 1 ? `connector ${cs[0]}` : `${cs.length} connectors`}` };
  },
  // a connector's end moved along its lane: { connector, end: "from" | "to", s }
  moveConnectorEnd(sk, a) {
    only(a, ["connector", "end", "s"]);
    const id = str(a, "connector", true), c = sk.connectors.find(x => x.id === id) ?? fail(`no connector ${id}`), end = str(a, "end", true);
    if (end !== "from" && end !== "to") fail(`"end": "from" or "to"`);
    const at = c[end as "from" | "to"], L = laneLength(lane(sk, at.lane).shape), s = num(a, "s", 0, Math.round(L * 1000) / 1000, true);
    const next = { ...sk, connectors: sk.connectors.map(x => (x.id === id ? { ...x, [end]: { ...at, s } } : x)) };
    return { sketch: next, result: { connector: id, [end]: { lane: at.lane, s } }, at: near(sk, { lane: at.lane, s }), said: `moved connector ${id}'s ${end} end` };
  },
  // a sign at lanes' ends: { lanes, control: "yield" | "stop" | "none" }; or "lights": traffic lights on the junctions they lead into
  setControl(sk, a) {
    only(a, ["lanes", "control"]);
    const ls = ids(a, "lanes", "lane", id => !!laneById(sk, id)), control = str(a, "control", true);
    if (!["yield", "stop", "none", "lights"].includes(control)) fail(`"control": "yield" (give way), "stop", "lights" or "none"`);
    const at = (() => { const l = laneById(sk, ls[0])!; return pointAt(l.shape, laneLength(l.shape)).p; })();
    if (control !== "lights") {
      // (those that have it already left as they are: nothing to undo for them)
      const want = control === "none" ? undefined : (control as "yield" | "stop");
      const next = ls.filter(id => laneById(sk, id)!.control !== want).reduce((s, id) => setControl(s, id, want ?? null), sk);
      return { sketch: next, result: { lanes: ls, control }, at, said: `${control === "none" ? "took the signs off" : control === "yield" ? "put give-way lines on" : "put stop signs on"} ${ls.length === 1 ? `lane ${ls[0]}` : `${ls.length} lanes`}` };
    }
    // (lights: the junctions whose connectors leave these lanes' ends; their signs taken off, as lights replace them)
    const cs = contentsOf(sk), js = sk.junctions.filter(j => cs.get(j.id)?.connectors.some(id => { const c = sk.connectors.find(x => x.id === id); return !!c && ls.includes(c.from.lane); }));
    if (!js.length) fail(`lane${ls.length > 1 ? "s" : ""} ${ls.join(", ")} lead${ls.length > 1 ? "" : "s"} into no junction: lights go on a junction (draw one round the connectors first)`);
    let next = ls.reduce((s, id) => setControl(s, id, null), sk);
    next = { ...next, junctions: next.junctions.map(j => (js.includes(j) && !j.lights ? { ...j, lights: { ...DEFAULT_LIGHTS } } : j)) };
    return { sketch: next, result: { lanes: ls, control, junctions: js.map(j => j.id) }, at, said: `put traffic lights on ${js.map(j => j.name).join(", ")}` };
  },
  // traffic lights on a junction or taken off: { junction, on }
  setLights(sk, a) {
    only(a, ["junction", "on"]);
    const id = str(a, "junction", true), j = sk.junctions.find(x => x.id === id) ?? fail(`no junction ${id}`), on = bool(a, "on") ?? fail(`"on" is needed (true or false)`);
    const next = !!j.lights === on ? sk : { ...sk, junctions: sk.junctions.map(x => { if (x.id !== id) return x; if (on) return { ...x, lights: { ...DEFAULT_LIGHTS } }; const { lights: _, ...rest } = x; return rest; }) };
    return { sketch: next, result: { junction: id, lights: on }, at: middle(j.outline), said: `${on ? "put traffic lights on" : "took the traffic lights off"} ${j.name}` };
  },
  // lanes made into one road (out of the roads they were in), side by side as the editor lays roads out: { lanes, name? }
  groupRoad(sk, a) {
    only(a, ["lanes", "name"]);
    const ls = ids(a, "lanes", "lane", id => !!laneById(sk, id)), id = nextId("r", sk.roads.map(r => r.id)), name = str(a, "name") ?? `Road ${id.slice(1)}`;
    return { sketch: groupRoad(sk, ls, id, name.slice(0, 80)), result: { road: id, name: name.slice(0, 80), lanes: ls }, at: near(sk, { lane: ls[0], s: 0 }), said: `grouped ${ls.length} lane${ls.length > 1 ? "s" : ""} into ${name.slice(0, 80)}` };
  },
  // a junction drawn by its outline: { outline (3 points or more), name? }
  addJunction(sk, a) {
    only(a, ["outline", "name"]);
    const outline = pts(a, "outline", 3, true), id = nextId("j", sk.junctions.map(j => j.id)), name = (str(a, "name") ?? `Junction ${id.slice(1)}`).slice(0, 80);
    return { sketch: { ...sk, junctions: [...sk.junctions, { id, name, outline }] }, result: { junction: id, name }, at: middle(outline), said: `drew junction ${name}` };
  },
  // junctions deleted (their lanes and connectors kept): { junctions }
  deleteJunctions(sk, a) {
    only(a, ["junctions"]);
    const js = ids(a, "junctions", "junction", id => sk.junctions.some(j => j.id === id)), first = sk.junctions.find(j => j.id === js[0])!;
    return { sketch: remove(sk, { junctions: js }), result: { deleted: js }, at: middle(first.outline), said: `deleted ${js.length === 1 ? first.name : `${js.length} junctions`}` };
  },
  // a roundabout stamped (as the Roundabout tool): its ring at { x, y }, radius r (m), the roads it crosses cut and joined to it
  roundabout(sk, a) {
    only(a, ["x", "y", "r"]);
    const c = { x: num(a, "x", -1e6, 1e6, true), y: num(a, "y", -1e6, 1e6, true) }, r = num(a, "r", 8, 80, true);
    const out = stampRoundabout(sk, c, r);
    return { sketch: out.sketch, result: { junction: out.junction, ring: out.ring }, at: c, said: `stamped a roundabout (r ${r} m)` };
  },
};

/** the plan's sketches picked or made (T156): done by the page (the Sketch window's), with the leave for the whole plan only */
export const SKETCH_EDITS = ["openSketch", "newSketch", "duplicateSketch"] as const;
/** the edit actions an agent may ask for (`app` commands; the server refuses them unless the user allows agent edits) */
export const EDIT_ACTIONS: readonly string[] = [...Object.keys(EDITS), "batch", ...SKETCH_EDITS];
/** those done on an editor's sketch (all but the sketches': see SKETCH_EDITS) */
export const MAP_EDITS: readonly string[] = [...Object.keys(EDITS), "batch"];
export const isEditAction = (name: string) => EDIT_ACTIONS.includes(name);

/**
 * A batch's action's arguments with "$0", "$1"… (alone, as a string) put back as the id the action that many places
 * before in the batch made (its lane, connector, junction or road), so an action can name what an earlier one made
 */
function refs(v: unknown, results: Record<string, unknown>[], i: number): unknown {
  if (typeof v === "string" && /^\$\d+$/.test(v)) {
    const k = Number(v.slice(1)), r = results[k];
    if (k >= i || !r) return fail(`"${v}": only an earlier action in the batch (0 to ${i - 1})`);
    const id = r.lane ?? r.connector ?? r.junction ?? r.road;
    return typeof id === "string" ? id : fail(`"${v}": action ${k} made nothing with an id`);
  }
  if (Array.isArray(v)) return v.map(x => refs(x, results, i));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, refs(x, results, i)]));
  return v;
}

/**
 * An edit applied to `sk`, its arguments checked; an error saying what was expected, and nothing changed, otherwise.
 * `batch` ({ actions: [{ action, args }] }, at most 50): each in turn on what the one before left, all or none; "$k" in
 * an action's arguments: the id the k-th action made.
 */
export function applyEdit(sk: Sketch, action: string, args: unknown): EditDone {
  const a = args === undefined ? {} : isObj(args) ? args : fail(`"args" must be an object`);
  if (action === "batch") {
    only(a, ["actions"]);
    const list = a.actions;
    if (!Array.isArray(list) || !list.length) fail(`"actions": a list of { action, args }`);
    if ((list as unknown[]).length > 50) fail(`"actions": at most 50 in a batch`);
    let cur = sk, at: Pt | null = null;
    const results: Record<string, unknown>[] = [], said: string[] = [];
    (list as unknown[]).forEach((x, i) => {
      if (!isObj(x) || typeof x.action !== "string") return fail(`"actions"[${i}]: { action, args }`);
      const name = x.action;
      if (name === "batch") fail(`"actions"[${i}]: a batch can't hold another`);
      try {
        const d = applyEdit(cur, name, refs(x.args, results, i));
        cur = d.sketch; at ??= d.at; results.push(d.result); said.push(d.said);
      } catch (e) { fail(`"actions"[${i}] (${name}): ${e instanceof Error ? e.message : String(e)}; nothing in the batch was done`); }
    });
    return { sketch: cur, result: { results }, at, said: said.length <= 3 ? said.join(", ") : `${said.slice(0, 2).join(", ")} and ${said.length - 2} more` };
  }
  const f = Object.hasOwn(EDITS, action) ? EDITS[action] : null;
  if (!f) fail(`no edit "${action}": ${EDIT_ACTIONS.join(", ")}`);
  return f!(sk, a);
}
