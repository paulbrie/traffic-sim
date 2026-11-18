/**
 * The 3D view's roads keep the points they need (sketch3d.ts `simplify`): a straight lane over a rise kept curved with it,
 * never more than a few centimetres off its heights (ticket #273: Bistrița Auto Search's Road 1693 drawn as the chord under
 * the rise, in the terrain, its lines and name left showing over it), a ramp's knees kept, a flat straight lane two points,
 * a ring (its ends one point) still a ring (ticket #262).   npm run sketch3d:check
 */
import { simplify } from "../src/render/sketch3d";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };

/** the heights drawn at each point: between the points kept, along the line */
function drawn(pts: { x: number; y: number }[], hs: number[], kept: { i: number }[]): number[] {
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < pts.length; i++) {
    while (k < kept.length - 2 && kept[k + 1].i <= i) k++;
    const a = kept[k].i, b = kept[k + 1]?.i ?? a, f = b > a ? (i - a) / (b - a) : 0;
    out.push(hs[a] + (hs[b] - hs[a]) * f);
  }
  return out;
}
const run = (hs: number[], step = 2) => {
  const pts = hs.map((_, i) => ({ x: i * step, y: 0, i }));
  const kept = simplify(pts, 0.05, hs) as typeof pts;
  const off = Math.max(...drawn(pts, hs, kept).map((h, i) => Math.abs(h - hs[i])));
  return { kept: kept.length, off };
};

// a 300 m straight lane over a rise 2.5 m high (a parabola: a 2 m step's grade changing far less than the 2 cm it took before)
{
  const hs = Array.from({ length: 151 }, (_, i) => { const x = (i * 2 - 150) / 150; return 2.5 * (1 - x * x); });
  const r = run(hs);
  check("a straight lane over a rise: drawn within 3 cm of its heights", r.off <= 0.031, `${r.kept} points kept of 151, at most ${(r.off * 100).toFixed(1)} cm off`);
  check("…with far fewer points than it has", r.kept < 40, `${r.kept}`);
}
{
  const hs = Array.from({ length: 101 }, (_, i) => (i < 25 ? 0 : i < 50 ? ((i - 25) / 25) * 6 : 6));
  const r = run(hs);
  check("a ramp up a level: its knees kept, drawn as it is", r.off < 1e-9 && r.kept === 4, `${r.kept} points, ${r.off.toFixed(3)} m off`);
}
{
  const r = run(Array.from({ length: 101 }, () => 0));
  check("a flat straight lane: its two ends", r.kept === 2, `${r.kept}`);
}
{
  const ring = Array.from({ length: 73 }, (_, i) => ({ x: 20 * Math.cos((i * 5 * Math.PI) / 180), y: 20 * Math.sin((i * 5 * Math.PI) / 180) }));
  const kept = simplify(ring, 0.05);
  check("a ring (its ends one point): still round", kept.length > 30, `${kept.length} points of 73`);
}

if (!ok) process.exit(1);
