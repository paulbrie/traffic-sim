/**
 * The live traffic fetched from TomTom for the plan open (ticket #33; see src/lib/tomtom.ts): kept in the page only,
 * never saved with the plan (TomTom's terms limit storing it), gone on leaving the plan. The editor matches it onto the
 * sketch (`trafficMatcher`); the map's "Live traffic" layer, the Live traffic panel and the Roads results read the match.
 * Each pull from TomTom (the incidents polled while Live traffic sync is on, the roads' speeds fetched) goes in `trafficLog$`,
 * which the console lists.
 */
import { Subject } from "subjecto";
import { trafficMatcher, type TrafficMatch, type TrafficSnapshot } from "@/lib/tomtom";
import type { Sketch } from "@/lib/lane-sketch";

export interface LiveTraffic {
  /** the plan it was fetched for */
  plan: string;
  snapshot: TrafficSnapshot;
  match: (sk: Sketch) => TrafficMatch | null;
}

export const liveTraffic$ = new Subject<LiveTraffic | null>(null, { name: "liveTraffic" });

export function setLiveTraffic(plan: string, snapshot: TrafficSnapshot) {
  liveTraffic$.next({ plan, snapshot, match: trafficMatcher(snapshot) });
}
export const clearLiveTraffic = () => liveTraffic$.next(null);

/** a pull from TomTom: when (ms), what (the incidents polled, the roads' speeds fetched), how many came back or what went wrong */
export interface TrafficPull { at: number; what: "incidents" | "speeds"; plan: string; count?: number; error?: string }
/** the pulls kept, newest first */
const LOG_MAX = 100;
export const trafficLog$ = new Subject<TrafficPull[]>([], { name: "trafficLog" });
export function logTrafficPull(p: Omit<TrafficPull, "at">) {
  trafficLog$.next([{ at: Date.now(), ...p }, ...trafficLog$.getValue()].slice(0, LOG_MAX));
}
export const clearTrafficLog = () => trafficLog$.next([]);
