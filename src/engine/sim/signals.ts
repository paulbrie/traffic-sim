import type { CNode } from "../compile";
import { DT, type Vehicle, type NodeState } from "./base";
import { SimRouting } from "./routing";
import { signalAspect } from "../signals";

/** Traffic lights: phase timing (actuated or coordinated), the aspect for each lane, statistics per green. */
export abstract class SimSignals extends SimRouting {
  /** where a coordinated junction is in its fixed cycle at the current time */
  protected planState(n: CNode): { phase: number; stage: 0 | 1 | 2; t: number } {
    const p = n.coord!;
    let tc = (((this.tick * DT - p.offset) % p.cycle) + p.cycle) % p.cycle;
    for (const s of p.seq) {
      if (tc < s.green) return { phase: s.phase, stage: 0, t: tc };
      tc -= s.green;
      if (tc < p.yellow) return { phase: s.phase, stage: 1, t: tc };
      tc -= p.yellow;
      if (tc < p.allRed) return { phase: s.phase, stage: 2, t: tc };
      tc -= p.allRed;
    }
    const last = p.seq[p.seq.length - 1];
    return { phase: last.phase, stage: 2, t: 0 };
  }
  /** bookkeeping when a light changes: close the cycle of the phase that ends, start the new green */
  protected enterStage(st: NodeState, phase: number, stage: 0 | 1 | 2) {
    const n = st.node;
    if (stage === 2 && !(st.stage === 2 && st.phase === phase)) {
      for (const a of n.phases[phase]) {
        const c = st.cyc[a];
        c.hist.push({ n: c.count, green: (this.tick - c.greenAt) * DT, at: this.tick * DT });
        if (c.hist.length > 30) c.hist.shift();
        c.count = 0;
      }
    }
    const newGreen = stage === 0 && !(st.stage === 0 && st.phase === phase);
    st.phase = phase; st.stage = stage;
    if (newGreen) {
      if (this.logging(n)) this.ev(n, null, "signal", `green for ${n.phases[phase].map(a => n.arms[a].inEdge?.link.name || n.arms[a].link.id).join(" + ") || "nobody (all red)"}${n.coord ? ` (${n.coord.groupName})` : ""}`);
      for (const a of n.phases[phase]) { st.cyc[a].greenAt = this.tick; st.cyc[a].count = 0; }
    }
  }
  protected updateSignals() {
    for (const st of this.ns) {
      const n = st.node;
      if (!n.controlled || n.def.control !== "lights" || n.phases.length < 2) continue;
      if (n.coord) {
        const s = this.planState(n);
        if (s.phase !== st.phase || s.stage !== st.stage) this.enterStage(st, s.phase, s.stage);
        st.t = s.t;
        continue;
      }
      const sig = n.def.signal;
      st.t += DT;
      if (st.stage === 0) {
        const idle = (this.tick - st.demand[st.phase]) * DT > 2;
        const other = st.demand.some((d, i) => i !== st.phase && (this.tick - d) * DT < 1);
        if ((sig.actuated && st.t > n.phaseMinGreen[st.phase] && idle && other) || st.t >= n.phaseGreen[st.phase]) { st.stage = 1; st.t = 0; }
      } else if (st.stage === 1) {
        if (st.t >= sig.yellow) { this.enterStage(st, st.phase, 2); st.t = 0; }
      } else if (st.t >= sig.allRed) {
        this.enterStage(st, (st.phase + 1) % n.phases.length, 0); st.t = 0;
      }
    }
  }
  /**
   * Signal aspect for traffic arriving in `lane` of arm `armIdx` of node `nodeIdx` (null = no
   * signal). Without a lane: the approach as a whole (green when any of its lanes is green).
   * A lane that is also green in the next phase stays green through the change.
   */
  signalFor(nodeIdx: number, armIdx: number, lane?: number): "green" | "yellow" | "red" | null {
    const st = this.ns[nodeIdx];
    return signalAspect(st.node, st.phase, st.stage, armIdx, lane);
  }
  /** the phases in which a lane of an approach has green */
  protected lanePhases(n: CNode, armIdx: number, lane: number): number[] { return n.lanePhases[armIdx]?.[lane] ?? []; }
  nodeState(nodeIdx: number) {
    const st = this.ns[nodeIdx], c = st.node.coord;
    return {
      phase: st.phase, stage: st.stage, t: st.t, occupied: st.occ.length, phases: st.node.phases.length,
      /** position in the group cycle (s), for coordinated junctions */
      cycleAt: c ? (((this.tick * DT - c.offset) % c.cycle) + c.cycle) % c.cycle : null,
    };
  }
  /**
   * Traffic lights: vehicles let through per green, for each approach (arm index). `current`
   * counts the green in progress; `history` holds finished cycles (green includes yellow).
   */
  lightCycles(nodeIdx: number) {
    const st = this.ns[nodeIdx];
    return st.node.arms.map((a, i) => {
      if (!a.inEdge) return null;
      const c = st.cyc[i], h = c.hist;
      const green = !!st.node.phases[st.phase]?.includes(i) && st.stage < 2;
      const avg = h.length ? h.reduce((s, x) => s + x.n, 0) / h.length : 0;
      const avgGreen = h.length ? h.reduce((s, x) => s + x.green, 0) / h.length : 0;
      return { arm: i, link: a.inEdge.link, dir: a.inEdge.dir, current: green ? c.count : null, history: h, avg, avgGreen };
    });
  }
  /**
   * Yellow: go only if stopping would need harder than comfortable braking.
   * Red: go only if the vehicle physically cannot stop before the line.
   */
  protected mustGoOnSignal(v: Vehicle, d: number, sig: "yellow" | "red" | null) {
    const vv = v.v * v.v;
    if (sig === "yellow") return d < vv / (2 * v.b * 1.4) + 0.5;
    return d < vv / (2 * v.bmax) + 0.3;
  }
}
