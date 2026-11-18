"use client";

/**
 * A V2 plan's background: the satellite imagery where the plan is on Earth (its sketch's `geo`), and
 * the reference image (the plan's underlay, as on V1 plans), with the panel to place both: a place
 * search, the imagery's brightness and source, and the image's position, scale (set by hand, or by
 * two points a known distance apart) and rotation; and the terrain under it (terrain-section.tsx), the buildings round it (buildings-section.tsx).
 */
import { useRef, useState } from "react";
import { useSubject } from "subjecto/react";
import { Crosshair, Loader2, MapPin, Ruler, Search, Trash2, Undo2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/workspace/fields";
import { formerGeo, type Pt, type Sketch } from "@/lib/lane-sketch";
import type { Underlay } from "@/lib/underlay";
import { unproject } from "@/lib/osm/area";
import { drawSatellite, googleImagery, SAT_ATTRIBUTION } from "@/render/satellite";
import { setUnderlay, ui, underlay$ } from "@/state/store";
import { useSketchStore } from "@/state/lane-sketch";
import { removeUnderlay, underlayImg$, uploadUnderlay } from "@/state/underlay-image";
import { InspectorPanel } from "./inspector-panel";
import { TerrainSection } from "./terrain-section";
import { BuildingsSection } from "./buildings-section";

// (how the imagery is shown: src/state/sat-options.ts, kept in the V2 UI store)
export { loadSatOptions, saveSatOptions, type SatOptions } from "@/state/sat-options";
import type { SatOptions } from "@/state/sat-options";
import { isEnter } from "@/lib/enter-key";

/** two points clicked on the sketch to set the image's scale by a distance known between them */
export interface Calibration { a: Pt | null; b: Pt | null }

/** what the background draws: the imagery (where the plan is), the image, a calibration in progress */
export interface Background {
  geo: { lat: number; lon: number } | null;
  satellite: boolean; sat: SatOptions;
  underlay: Underlay | null; img: HTMLImageElement | null;
  calib: Calibration | null;
  /** a tile came in: draw again */
  onTile: () => void;
}

/** the background under the sketch; `ctx` in sketch metres, `view` the rectangle seen, `pxPerM` device pixels per metre */
export function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, view: { minX: number; minY: number; maxX: number; maxY: number }, pxPerM: number, px: number) {
  if (bg.satellite && bg.geo) {
    drawSatellite(ctx, bg.geo, view, pxPerM, bg.onTile, bg.sat.source);
    // (dimmed, so the lanes stand out)
    if (bg.sat.brightness < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - bg.sat.brightness})`; ctx.fillRect(view.minX, view.minY, view.maxX - view.minX, view.maxY - view.minY); }
  }
  const u = bg.underlay;
  if (u && u.visible && bg.img) {
    ctx.save();
    ctx.translate(u.x, u.y); ctx.rotate((u.rot * Math.PI) / 180);
    ctx.globalAlpha = u.opacity; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bg.img, (-u.w * u.mpp) / 2, (-u.h * u.mpp) / 2, u.w * u.mpp, u.h * u.mpp);
    ctx.restore();
  }
  const c = bg.calib;
  if (c?.a) {
    ctx.strokeStyle = "#f97316"; ctx.fillStyle = "#f97316"; ctx.lineWidth = 2 * px;
    for (const p of [c.a, c.b]) if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2); ctx.fill(); }
    if (c.b) { ctx.beginPath(); ctx.moveTo(c.a.x, c.a.y); ctx.lineTo(c.b.x, c.b.y); ctx.stroke(); }
  }
}

interface Place { name: string; lat: number; lon: number }

/**
 * The panel: where the plan is (a place search puts it under the middle of the view), the imagery,
 * and the reference image.
 */
export function BackgroundPanel({ sketch, sat, setSat, viewNow, calib, setCalib, readOnly }: {
  sketch: Sketch; sat: SatOptions; setSat: (o: SatOptions) => void;
  /** the view now: its middle and how big it is, metres */
  viewNow: () => { cx: number; cy: number; wm: number; hm: number };
  calib: Calibration | null; setCalib: (c: Calibration | null) => void;
  readOnly: boolean;
}) {
  const { edit: editSketch } = useSketchStore();
  const [u] = useSubject(underlay$);
  const [img] = useSubject(underlayImg$);
  const [q, setQ] = useState(""), [places, setPlaces] = useState<Place[] | null>(null), [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false), [dist, setDist] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const planId = ui.getValue().planId;

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q.trim())}`, { headers: { Accept: "application/json" } });
      const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
      setPlaces(rows.map(r => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) })));
    } catch { toast.error("Couldn't search for places"); } finally { setSearching(false); }
  }
  // (ticket #271) where it was when its terrain or buildings were fetched, if not there now
  const was = formerGeo(sketch);
  const putBack = (g: { lat: number; lon: number }) => {
    editSketch(s => ({ ...s, geo: { lat: g.lat, lon: g.lon } }));
    toast.success("Put back where it was", { description: `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}` });
  };
  /** off the map (an Undo with it: one click on the ✕ takes the imagery, terrain and buildings away) */
  const offMap = () => {
    const g = sketch.geo;
    editSketch(s => { const n = { ...s }; delete n.geo; return n; });
    if (g) toast("Taken off the map", { description: "No satellite imagery; terrain and buildings hidden until it is put back.", action: { label: "Undo", onClick: () => editSketch(s => ({ ...s, geo: g })) } });
  };
  /** the place put under the middle of the view (the sketch stays where it is; the Earth moves under it) */
  const place = (p: Place) => {
    const v = viewNow(), geo = unproject({ lat: p.lat, lon: p.lon }, { x: -v.cx, y: -v.cy });
    editSketch(s => ({ ...s, geo: { lat: Number(geo.lat.toFixed(7)), lon: Number(geo.lon.toFixed(7)) } }));
    setPlaces(null);
    toast.success("Placed", { description: `${p.name.split(",").slice(0, 2).join(",")} is now under the middle of the view.` });
  };
  const fit = (x: Underlay) => { const v = viewNow(); return { ...x, x: Math.round(v.cx), y: Math.round(v.cy), mpp: Math.min((v.wm * 0.9) / x.w, (v.hm * 0.9) / x.h) }; };
  async function upload(f: File) {
    setUploading(true);
    const fresh = !underlay$.getValue();
    try { await uploadUnderlay(planId, f); if (fresh) setUnderlay(fit); } catch (e) { toast.error(e instanceof Error ? e.message : "Upload failed"); } finally { setUploading(false); }
  }
  const measured = calib?.a && calib.b ? Math.hypot(calib.b.x - calib.a.x, calib.b.y - calib.a.y) : null;
  const applyCalib = () => {
    const real = Number(dist.replace(",", "."));
    if (!calib?.a || !measured || !(real > 0)) return;
    const k = real / measured, a = calib.a;
    // (scaled about the first point, which stays where it is)
    setUnderlay(x => ({ ...x, mpp: x.mpp * k, x: a.x + (x.x - a.x) * k, y: a.y + (x.y - a.y) * k }));
    setCalib(null); setDist("");
    toast.success("Scale set", { description: `${measured.toFixed(1)} m on the image is now ${real} m.` });
  };

  return (
    <InspectorPanel id="background" title="Background">
      {/* where it is */}
      <div className="grid gap-1.5">
        <span className="flex items-center gap-1.5 text-xs"><MapPin className="size-3.5 text-muted-foreground" />
          {sketch.geo ? <span className="font-mono tabular text-muted-foreground">{sketch.geo.lat.toFixed(5)}, {sketch.geo.lon.toFixed(5)}</span> : <span className="text-muted-foreground">Not placed on the map yet</span>}
          {sketch.geo && !readOnly && <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Take the plan off the map" title="Take the plan off the map (no satellite imagery)" onClick={offMap}><X /></Button>}
        </span>
        {was && !readOnly && (
          <div className="grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-1.5">
            <span className="text-[11px] text-amber-700 dark:text-amber-400">
              {sketch.geo ? "Placed somewhere else than" : "Taken off the map from"} where its {[sketch.terrain && "terrain", sketch.buildings && "buildings"].filter(Boolean).join(" and ")} {sketch.buildings ? "were" : "was"} fetched (<span className="font-mono tabular">{was.lat.toFixed(5)}, {was.lon.toFixed(5)}</span>): back there, the imagery lines up with the lanes as it did, and they show again.
            </span>
            <Button size="sm" variant="outline" onClick={() => putBack(was)}><Undo2 /> Put it back where it was</Button>
          </div>
        )}
        {!readOnly && (
          <div role="search" className="flex gap-1.5">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a place, to put under the view" aria-label="Find a place" className="h-8 text-xs"
              onKeyDown={e => { if (isEnter(e)) { e.preventDefault(); void search(); } }} />
            <Button size="icon-sm" variant="secondary" className="size-8" disabled={searching} onClick={() => void search()} aria-label="Search">{searching ? <Loader2 className="animate-spin" /> : <Search />}</Button>
          </div>
        )}
        {places && (
          <div className="grid max-h-40 overflow-y-auto rounded-md border">
            {!places.length && <span className="px-2 py-1.5 text-xs text-muted-foreground">No place found</span>}
            {places.map((p, i) => (
              <button key={i} className="truncate px-2 py-1.5 text-left text-xs hover:bg-muted" title={p.name} onClick={() => place(p)}>{p.name}</button>
            ))}
          </div>
        )}
        {sketch.geo && (
          <>
            <label className="grid gap-1 text-xs">
              <span className="flex justify-between text-muted-foreground"><span>Imagery brightness</span><span className="font-mono tabular">{Math.round(sat.brightness * 100)}%</span></span>
              <Slider value={[sat.brightness]} min={0.3} max={1} step={0.05} onValueChange={([b]) => setSat({ ...sat, brightness: b })} aria-label="Imagery brightness" />
            </label>
            {googleImagery && (
              <div className="flex gap-1.5">
                {(["esri", "google"] as const).map(s => <Button key={s} size="sm" variant={sat.source === s ? "secondary" : "ghost"} className="h-7 flex-1 text-xs" onClick={() => setSat({ ...sat, source: s })}>{s === "esri" ? "Esri" : "Google"}</Button>)}
              </div>
            )}
            {sat.source === "esri" && <p className="text-[10px] text-muted-foreground">{SAT_ATTRIBUTION}</p>}
          </>
        )}
      </div>
      <TerrainSection sketch={sketch} planId={planId} readOnly={readOnly} />
      <BuildingsSection sketch={sketch} planId={planId} readOnly={readOnly} />
      {/* the reference image */}
      <div className="grid gap-1.5 border-t pt-2">
        <span className="text-xs text-muted-foreground">Reference image{u ? `: ${u.name}` : ""}</span>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        {!readOnly && (
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => file.current?.click()} title="A plan, a drawing or an aerial photo to draw over">
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />} {u ? "Replace image" : "Upload an image"}
          </Button>
        )}
        {u && (
          <>
            <label className="flex items-center justify-between gap-2 text-xs">Shown <Switch aria-label="Reference image shown" checked={u.visible} disabled={readOnly} onCheckedChange={visible => setUnderlay(x => ({ ...x, visible }))} /></label>
            <label className="grid gap-1 text-xs">
              <span className="flex justify-between text-muted-foreground"><span>Opacity</span><span className="font-mono tabular">{Math.round(u.opacity * 100)}%</span></span>
              <Slider value={[u.opacity]} min={0.05} max={1} step={0.05} disabled={readOnly} onValueChange={([opacity]) => setUnderlay(x => ({ ...x, opacity }))} aria-label="Image opacity" />
            </label>
            {!readOnly && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField id="v2-ul-x" label="Middle x" unit="m" digits={1} value={u.x} onCommit={x => setUnderlay(c => ({ ...c, x }))} />
                  <NumberField id="v2-ul-y" label="Middle y" unit="m" digits={1} value={u.y} onCommit={y => setUnderlay(c => ({ ...c, y }))} />
                  <NumberField id="v2-ul-w" label="Width on the ground" unit="m" digits={1} min={1} value={u.w * u.mpp} onCommit={wm => setUnderlay(c => ({ ...c, mpp: wm / c.w }))} />
                  <NumberField id="v2-ul-rot" label="Rotation" unit="°" digits={1} min={-360} max={360} value={u.rot} onCommit={rot => setUnderlay(c => ({ ...c, rot }))} />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => setUnderlay(x => { const v = viewNow(); return { ...x, x: Math.round(v.cx), y: Math.round(v.cy) }; })} title="Put the image's middle in the middle of the view"><Crosshair /> To the view</Button>
                  <Button size="sm" variant={calib ? "secondary" : "outline"} onClick={() => setCalib(calib ? null : { a: null, b: null })} title="Click two points on the image a known distance apart, then give the distance"><Ruler /> Set scale</Button>
                </div>
                {calib && (
                  <div className="grid gap-1.5 rounded-md border border-orange-300 bg-orange-50 p-2 text-xs dark:border-orange-800 dark:bg-orange-950/40">
                    {!calib.a ? "Click the first of two points a known distance apart on the image." : !calib.b ? "Now click the second point." : (
                      <>
                        <span>Measured {measured!.toFixed(1)} m. How far apart are they really?</span>
                        <div className="flex gap-1.5">
                          <Input autoFocus value={dist} onChange={e => setDist(e.target.value)} placeholder="metres" className="h-7 text-xs" onKeyDown={e => { if (isEnter(e)) applyCalib(); }} aria-label="Real distance in metres" />
                          <Button size="sm" className="h-7" onClick={applyCalib}>Apply</Button>
                        </div>
                      </>
                    )}
                    <Button size="sm" variant="ghost" className="h-6 justify-self-start px-1 text-xs" onClick={() => { setCalib(null); setDist(""); }}>Cancel</Button>
                  </div>
                )}
                <Button size="sm" variant="ghost" className="justify-start" onClick={() => { if (confirm("Remove the reference image?")) void removeUnderlay(planId).catch(e => toast.error(String(e))); }}><Trash2 /> Remove image</Button>
              </>
            )}
            {!img && <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading the image…</span>}
          </>
        )}
      </div>
    </InspectorPanel>
  );
}
