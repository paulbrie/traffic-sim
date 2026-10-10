/**
 * Why a car does what it does (T157): the sim's record for the car picked (`CarExplain`, traced live by the sim for
 * the car watched; for a car picked in a replay, what the recording keeps), put in plain words for the car's panel,
 * the map, the copy and the bridge. Framework-free.
 */
import type { Pt } from "./lane-sketch";

/** the rule holding a car back (or "follow": a car ahead; none: a free road) */
export type ExplainRule = "follow" | "give-way" | "priority" | "stop" | "signal" | "merge" | "ring-full" | "zone" | "zebra" | "keep-clear" | "letting-in" | "lane-change" | "broken" | "forced";

/** the sim's account of one car at one moment (lane-sketch-sim's `explain`); edges are keys ("lane:l5", "conn:c7") */
export interface CarExplain {
  car: number; t: number;
  /** false: from the recording only (a car not watched at that moment); what it can't give is null or empty */
  traced: boolean;
  /** the sim's own tag, as `inspect` has it */
  why: string | null;
  rule: null | { kind: ExplainRule; edge?: string; detail?: string };
  /** km/h; target: what the car-following model chose this step; accel m/s² */
  speed: null | { kmh: number; desiredKmh: number; targetKmh: number; accel: number };
  /** the car ahead on its path: bumper gap (m) and its speed (km/h) */
  leader: null | { car: number; gap: number; kmh: number };
  /** the car holding it (give way, merge, zone…): the gap seen and needed (m), seconds to the zone (theirs) and to clear it (mine), the conflict zone on both paths */
  blocker: null | { car: number; edge: string; gap?: number; needGap?: number; theirSec?: number; mySec?: number; zone?: { mine: Pt[]; theirs: Pt[] } };
  /** the point it holds for: on `edge` at `s`, `dist` m ahead of its front */
  stopAt: null | { edge: string; s: number; dist: number; why: string };
  /** seconds with the same rule and blocker */
  since: number;
  /** its blocker, that car's blocker… (not the car itself); when it loops, the last is the first one repeated */
  chain: number[];
  /** the ring when the chain loops (a deadlock) */
  deadlock: number[] | null;
  plan: null | {
    next: string | null; goal: string | null; dest: string | null;
    laneChange: null | { to: string; why: string };
    /** the gaps it turned down lately */
    rejected: { t: number; edge: string; gap: number; need: number; car?: number }[];
  };
  /** its last decisions and changes of state, oldest first (about 30) */
  log: { t: number; what: string; text: string; car?: number }[];
}

export const edgeName = (key: string) => key.replace(/^lane:/, "lane ").replace(/^conn:/, "connector ");
const m1 = (x: number) => `${x.toFixed(1)} m`;
const s1 = (x: number) => `${x.toFixed(1)} s`;
const kmh = (x: number) => x.toFixed(0);

/** what each rule is called in a sentence */
export const RULE_WORDS: Record<ExplainRule, string> = {
  follow: "following", "give-way": "give way", priority: "priority", stop: "stop line", signal: "traffic light", merge: "merging", "ring-full": "ring full", zone: "first come, first served",
  zebra: "zebra crossing", "keep-clear": "keeping the junction clear", "letting-in": "letting a car in", "lane-change": "changing lane", broken: "broken down", forced: "let go (deadlock)",
};

/** the explanation's headline in plain words, with the car it is about (to link) */
export function headline(x: CarExplain): { text: string; car?: number } {
  const r = x.rule?.kind, b = x.blocker, on = (e?: string) => (e ? ` on ${edgeName(e)}` : "");
  const speedNow = x.speed ? `${kmh(x.speed.kmh)} of ${kmh(x.speed.desiredKmh)} km/h` : null;
  if (x.deadlock) return { text: `Deadlock: ${x.deadlock.join(" → ")} → ${x.deadlock[0]} all wait on each other`, car: x.deadlock[0] };
  if (!r) return { text: speedNow ? `Free road, ${speedNow}` : "Free road" };
  if (r === "follow" && x.leader) return { text: `Following car ${x.leader.car}, ${x.leader.gap.toFixed(0)} m gap${speedNow ? `, ${speedNow}` : ""}`, car: x.leader.car };
  if ((r === "merge" || r === "lane-change") && b?.gap !== undefined && b.needGap !== undefined)
    return { text: `${r === "merge" ? `Merging onto ${edgeName(x.rule?.edge ?? b.edge)}` : `Changing to ${edgeName(x.rule?.edge ?? b.edge)}`}: gap ${m1(b.gap)} too short (needs ${b.needGap.toFixed(0)} m)`, car: b.car };
  if (b && (r === "give-way" || r === "priority" || r === "zone" || r === "keep-clear" || r === "merge" || r === "ring-full"))
    return { text: `Waiting for car ${b.car} crossing its path${on(b.edge)} (${RULE_WORDS[r]}, ${s1(x.since)})`, car: b.car };
  if (r === "letting-in" && b) return { text: `Letting car ${b.car} in (${s1(x.since)})`, car: b.car };
  if (r === "signal") return { text: `At the light${on(x.rule?.edge)}${x.rule?.detail ? ` (${x.rule.detail})` : ""}, ${s1(x.since)}` };
  if (r === "stop") return { text: `At the stop line${on(x.rule?.edge)}, ${s1(x.since)}` };
  if (r === "zebra") return { text: `Stopping for pedestrians${x.rule?.detail ? ` at ${x.rule.detail}` : ""}, ${s1(x.since)}` };
  if (r === "broken") return { text: `Broken down, ${s1(x.since)}` };
  if (r === "forced") return { text: "Let go by the deadlock breaker: it goes without giving way" };
  return { text: `${RULE_WORDS[r].charAt(0).toUpperCase()}${RULE_WORDS[r].slice(1)}${on(x.rule?.edge)}${b ? `, car ${b.car}` : ""} (${s1(x.since)})`, car: b?.car };
}

/** the explanation as plain text, to copy (for pasting into a conversation, and the bridge) */
export function explainText(x: CarExplain, clock: (t: number) => string): string {
  const out = [`Car ${x.car} at ${clock(x.t)}${x.traced ? "" : " (from the recording: a car not watched then)"}: ${headline(x).text}`];
  if (x.rule) out.push(`Rule: ${RULE_WORDS[x.rule.kind]}${x.rule.edge ? ` on ${edgeName(x.rule.edge)}` : ""}${x.rule.detail ? ` (${x.rule.detail})` : ""}, for ${s1(x.since)}`);
  if (x.speed) out.push(`Speed: ${kmh(x.speed.kmh)} km/h now, ${kmh(x.speed.desiredKmh)} desired, ${kmh(x.speed.targetKmh)} target (${x.speed.accel.toFixed(1)} m/s²)`);
  if (x.leader) out.push(`Leader: car ${x.leader.car}, ${m1(x.leader.gap)} ahead at ${kmh(x.leader.kmh)} km/h`);
  if (x.blocker) {
    const b = x.blocker, extra = [b.gap !== undefined ? `gap ${m1(b.gap)}` : "", b.needGap !== undefined ? `needs ${m1(b.needGap)}` : "", b.theirSec !== undefined ? `it reaches the zone in ${s1(b.theirSec)}` : "", b.mySec !== undefined ? `this one clears it in ${s1(b.mySec)}` : ""].filter(Boolean);
    out.push(`Held by: car ${b.car} on ${edgeName(b.edge)}${extra.length ? ` (${extra.join(", ")})` : ""}`);
  }
  if (x.stopAt) out.push(`Holding for: ${x.stopAt.why}, ${m1(x.stopAt.dist)} ahead (${edgeName(x.stopAt.edge)} at ${m1(x.stopAt.s)})`);
  if (x.chain.length) out.push(`Blocking chain: ${[x.car, ...x.chain].join(" → ")}${x.deadlock ? `  DEADLOCK ring: ${x.deadlock.join(", ")}` : ""}`);
  if (x.plan) {
    const p = x.plan;
    out.push(`Plan: next ${p.next ? edgeName(p.next) : "—"}${p.goal ? `, goal ${edgeName(p.goal)}` : ""}${p.dest ? `, to the exit at ${edgeName(p.dest)}` : ""}${p.laneChange ? `; changing to ${edgeName(p.laneChange.to)} (${p.laneChange.why})` : ""}`);
    for (const g of p.rejected) out.push(`  turned down at ${clock(g.t)}: ${edgeName(g.edge)}, gap ${m1(g.gap)} < ${m1(g.need)}${g.car !== undefined ? ` (car ${g.car})` : ""}`);
  }
  if (x.log.length) {
    out.push("Recent decisions:");
    for (const l of x.log) out.push(`  ${clock(l.t)} ${l.what}: ${l.text}`);
  }
  return out.join("\n");
}

/** the cars to point at on the map: its leader and its blocker (where they are drawn now) */
export function explainMarks(x: CarExplain | null, at: (car: number) => Pt | null): { leader: Pt | null; blocker: Pt | null; zone: { mine: Pt[]; theirs: Pt[] } | null } | null {
  if (!x) return null;
  return { leader: x.leader ? at(x.leader.car) : null, blocker: x.blocker ? at(x.blocker.car) : null, zone: x.blocker?.zone ?? null };
}
