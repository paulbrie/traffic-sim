/**
 * The spatial driving experiment as the page sees it (T213): its worker (spatial-sim.worker.ts), what it last sent, and its
 * drawing over the map (the cars, each spatial car's ray fan and the way out it is going for, the car picked and the path it
 * wants to take). Imported only when the Sketch window's experiment switch is on, so the normal Run path loads none of it.
 */
import type { Sketch } from "@/lib/lane-sketch";
import type { SpatialCarInfo, SpatialParams, SpatialStats } from "@/lib/experiments/spatial-roundabout/engine";
import type { SpatialFrame, ToSpatialWorker } from "./spatial-sim.worker";

export class SpatialSimClient {
  private worker: Worker;
  last: SpatialFrame | null = null;
  constructor(sketch: Sketch, params: SpatialParams, public onFrame: () => void) {
    this.worker = new Worker(new URL("./spatial-sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<SpatialFrame>) => { this.last = e.data; this.onFrame(); };
    this.send({ type: "init", sketch, params });
  }
  private send(m: ToSpatialWorker) { this.worker.postMessage(m); }
  run(running: boolean, speed: number) { this.send({ type: "run", running, speed }); }
  /** from the start again, on the sketch as it is now */
  reset(sketch: Sketch, params: SpatialParams) { this.last = null; this.picked = null; this.send({ type: "init", sketch, params }); }
  stats(): SpatialStats | null { return this.last?.stats ?? null; }
  /** whether the sketch has a junction the experiment drives */
  hasJunction() { return this.last?.junction ?? true; }
  /** the car picked (null: none): the worker sends it with each frame */
  picked: number | null = null;
  select(id: number | null) { this.picked = id; this.send({ type: "select", id }); }
  /** the picked car as last sent (null: none, or gone) */
  car(): SpatialCarInfo | null { return this.picked !== null && this.last?.car?.id === this.picked ? this.last.car : null; }
  /** the car whose body is at p (within `tol` m), or null */
  carAt(p: { x: number; y: number }, tol: number): number | null {
    let best: number | null = null, bd = Infinity;
    for (const c of this.last?.poses ?? []) {
      const dx = p.x - c.p.x, dy = p.y - c.p.y, along = Math.abs(dx * c.d.x + dy * c.d.y) - c.len / 2, side = Math.abs(-dx * c.d.y + dy * c.d.x) - 0.9;
      const d = Math.max(along, side, 0);
      if (d <= tol && d < bd) { bd = d; best = c.id; }
    }
    return best;
  }
  terminate() { this.worker.terminate(); }

  /** its cars over the map (`ctx` as the map's canvas, view centre and scale, CSS size): rays thin, goals dashed */
  draw(ctx: CanvasRenderingContext2D, view: { cx: number; cy: number; scale: number }, w: number, h: number, rays: boolean) {
    const f = this.last;
    if (!f) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), px = 1 / view.scale;
    ctx.save();
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * (w / 2 - view.cx * view.scale), dpr * (h / 2 - view.cy * view.scale));
    if (rays) {
      ctx.lineWidth = px;
      for (const p of f.poses) if ("rays" in p && p.rays && p.from) {
        for (const r of p.rays) { ctx.strokeStyle = r.car ? "rgba(239,68,68,0.45)" : "rgba(96,165,250,0.3)"; ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(r.x, r.y); ctx.stroke(); }
      }
    }
    // (the car picked: the path it wants to take, and where its way out starts)
    const sel = this.car();
    if (sel && sel.path.length > 1) {
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 4 * px; ctx.beginPath(); sel.path.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      ctx.strokeStyle = "#d946ef"; ctx.lineWidth = 2.2 * px; ctx.stroke();
      if (sel.goal) { ctx.fillStyle = "#d946ef"; ctx.beginPath(); ctx.arc(sel.goal.x, sel.goal.y, 4 * px, 0, 2 * Math.PI); ctx.fill(); }
    }
    ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = "rgba(250,204,21,0.8)";
    for (const p of f.poses) if (p.goal && "from" in p && p.from) { ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(p.goal.x, p.goal.y); ctx.stroke(); }
    ctx.setLineDash([]);
    for (const p of f.poses) {
      ctx.save();
      ctx.translate(p.p.x, p.p.y); ctx.rotate(Math.atan2(p.d.y, p.d.x));
      ctx.fillStyle = p.spatial ? "#f59e0b" : "#cbd5e1"; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = px;
      ctx.fillRect(-p.len / 2, -0.9, p.len, 1.8); ctx.strokeRect(-p.len / 2, -0.9, p.len, 1.8);
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(p.len / 2 - 1.1, -0.75, 0.5, 1.5);
      if (p.id === this.picked) { ctx.strokeStyle = "#d946ef"; ctx.lineWidth = 3 * px; ctx.strokeRect(-p.len / 2 - 0.3, -1.2, p.len + 0.6, 2.4); }
      ctx.restore();
    }
    ctx.restore();
  }
}
