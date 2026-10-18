/**
 * The spatial roundabout experiment as the page sees it (T213): its worker (spatial-sim.worker.ts), what it last sent, and its
 * drawing over the map (the cars, each spatial car's ray fan and the way out it is going for). Imported only when the Sketch
 * window's experiment switch is on, so the normal Run path loads none of it.
 */
import type { Sketch } from "@/lib/lane-sketch";
import type { SpatialParams, SpatialStats } from "@/lib/experiments/spatial-roundabout/engine";
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
  reset(sketch: Sketch, params: SpatialParams) { this.last = null; this.send({ type: "init", sketch, params }); }
  stats(): SpatialStats | null { return this.last?.stats ?? null; }
  /** whether the sketch has a roundabout the experiment drives (a junction round an island) */
  hasRoundabout() { return this.last?.roundabout ?? true; }
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
    ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = "rgba(250,204,21,0.8)";
    for (const p of f.poses) if (p.goal && "from" in p && p.from) { ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(p.goal.x, p.goal.y); ctx.stroke(); }
    ctx.setLineDash([]);
    for (const p of f.poses) {
      ctx.save();
      ctx.translate(p.p.x, p.p.y); ctx.rotate(Math.atan2(p.d.y, p.d.x));
      ctx.fillStyle = p.spatial ? "#f59e0b" : "#cbd5e1"; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = px;
      ctx.fillRect(-p.len / 2, -0.9, p.len, 1.8); ctx.strokeRect(-p.len / 2, -0.9, p.len, 1.8);
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(p.len / 2 - 1.1, -0.75, 0.5, 1.5);
      ctx.restore();
    }
    ctx.restore();
  }
}
