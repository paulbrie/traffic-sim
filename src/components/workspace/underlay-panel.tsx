"use client";

import { useRef, useState } from "react";
import { batch } from "subjecto";
import { useDeepSubject, useSubject } from "subjecto/react";
import { Crosshair, ImagePlus, Loader2, Move, Ruler, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { setTool, setUnderlay, ui, underlay$ } from "@/state/store";
import { removeUnderlay, underlayImg$, uploadUnderlay } from "@/state/underlay-image";
import { viewport } from "@/state/commands";
import { cn } from "@/lib/utils";
import { NumberField, Section } from "./fields";

export function UnderlayPanel() {
  const [u] = useSubject(underlay$);
  const [planId] = useDeepSubject(ui, "planId");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      await uploadUnderlay(planId, file);
      setTool("image");
      toast.success("Reference image added", { description: "Calibrate its scale, then trace your streets over it." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const input = (
    <input
      ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/*" className="sr-only" aria-label="Reference image file"
      onChange={e => upload(e.target.files?.[0])}
    />
  );
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files?.[0]); },
  };

  if (!u) {
    return (
      <Section>
        {input}
        <button
          type="button" {...dropProps} onClick={() => fileRef.current?.click()} disabled={busy}
          className={cn("grid place-items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center transition-colors hover:bg-muted/50", over && "border-primary bg-primary/5")}
        >
          {busy ? <Loader2 className="size-6 animate-spin text-muted-foreground" /> : <ImagePlus className="size-6 text-muted-foreground" />}
          <span className="text-sm font-medium">{busy ? "Uploading…" : "Add a reference image"}</span>
          <span className="text-xs text-muted-foreground">Drop a map screenshot, aerial photo or site drawing here, or click to choose. PNG, JPEG or WebP, up to 25 MB.</span>
        </button>
        <p className="text-xs text-muted-foreground">The image sits under your streets so you can trace them. It is stored with this plan.</p>
      </Section>
    );
  }

  const patch = (p: Partial<typeof u>) => setUnderlay(cur => ({ ...cur, ...p }));
  return (
    <div {...dropProps} className={cn(over && "bg-primary/5")}>
      {input}
      <Section title="Reference image">
        <div className="flex items-center gap-3">
          <Thumb />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={u.name}>{u.name}</div>
            <div className="font-mono text-xs text-muted-foreground tabular">{u.w} × {u.h} px · {(u.w * u.mpp).toFixed(0)} × {(u.h * u.mpp).toFixed(0)} m</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />} Replace
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="flex-1"><Trash2 /> Remove</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the reference image?</AlertDialogTitle>
                <AlertDialogDescription>The image and its placement are deleted from this plan. Your streets are not affected.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => removeUnderlay(planId).catch(e => toast.error(e.message))}>Remove image</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <label className="flex items-center justify-between gap-2 text-sm"><span>Show image</span><Switch checked={u.visible} onCheckedChange={v => patch({ visible: v })} /></label>
        <label className="flex items-center justify-between gap-2 text-sm"><span>Show on 3D ground</span><Switch checked={u.in3d} onCheckedChange={v => patch({ in3d: v })} /></label>
        <label className="flex items-center justify-between gap-2 text-sm"><span>Lock position</span><Switch checked={u.locked} onCheckedChange={v => patch({ locked: v })} /></label>
        <div className="grid gap-2">
          <div className="flex items-center justify-between"><Label htmlFor="ul-opacity" className="text-sm">Opacity</Label><span className="font-mono text-xs text-muted-foreground tabular">{Math.round(u.opacity * 100)}%</span></div>
          <Slider id="ul-opacity" min={5} max={100} step={1} value={[Math.round(u.opacity * 100)]} onValueChange={([v]) => patch({ opacity: v / 100 })} />
        </div>
      </Section>
      <Calibrate />
      <Section title="Placement">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="ul-x" label="Centre X" unit="m" value={u.x} digits={1} onCommit={v => patch({ x: v })} />
          <NumberField id="ul-y" label="Centre Y" unit="m" value={u.y} digits={1} onCommit={v => patch({ y: v })} />
          <NumberField id="ul-rot" label="Rotation" unit="°" value={u.rot} digits={1} step={0.5} onCommit={v => patch({ rot: ((v % 360) + 360) % 360 })} />
          <NumberField id="ul-width" label="Width on ground" unit="m" value={u.w * u.mpp} digits={1} min={1} onCommit={v => patch({ mpp: v / u.w })} />
        </div>
        <NumberField id="ul-mpp" label="Scale" unit="m/px" value={u.mpp} digits={4} step={0.001} min={0.0001} onCommit={v => patch({ mpp: v })} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" disabled={u.locked} onClick={() => setTool("image")}><Move /> Move on map</Button>
          <Button variant="outline" size="sm" className="flex-1" disabled={u.locked} onClick={() => patch({ x: Math.round(viewport.cx), y: Math.round(viewport.cy) })}><Crosshair /> Centre in view</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          With the image tool (<kbd className="font-mono">I</kbd>): drag the image to move it, drag a corner to scale, drag the round handle to rotate (hold Shift for 15° steps).
        </p>
      </Section>
    </div>
  );
}

function Thumb() {
  const [img] = useSubject(underlayImg$);
  return (
    <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob/API URL of a user image
        <img src={img.src} alt="" className="size-full object-cover" />
      ) : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}

function Calibrate() {
  const [calib] = useDeepSubject(ui, "calib");
  const [u] = useSubject(underlay$);
  const [real, setReal] = useState("");
  if (!u) return null;
  const measured = calib.a && calib.b ? Math.hypot(calib.b.x - calib.a.x, calib.b.y - calib.a.y) : 0;
  const start = () => {
    const c = ui.getValue().calib;
    batch(() => { c.active = true; c.a = null; c.b = null; });
    const t = ui.getValue();
    if (t.view !== "2d") t.view = "2d";
    setReal("");
  };
  const cancel = () => { const c = ui.getValue().calib; batch(() => { c.active = false; c.a = null; c.b = null; }); };
  const apply = () => {
    const d = Number(real.replace(",", "."));
    if (!calib.a || !(d > 0) || measured < 1e-6) return;
    const k = d / measured, a = calib.a;
    // scale about the first point so it stays where it is on the map
    setUnderlay(cur => ({ ...cur, mpp: cur.mpp * k, x: a.x + (cur.x - a.x) * k, y: a.y + (cur.y - a.y) * k }));
    cancel();
    toast.success(`Scale set: ${(u.mpp * k).toFixed(4)} m per pixel`);
  };
  return (
    <Section title="Scale">
      {!calib.active ? (
        <>
          <p className="text-xs text-muted-foreground">Click two points on the image whose real distance you know (a street length, a scale bar, a building front), then type that distance.</p>
          <Button variant="outline" size="sm" onClick={start} disabled={u.locked}><Ruler /> Calibrate scale</Button>
        </>
      ) : (
        <div className="grid gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm">
              {!calib.a ? "Click the first point on the image." : !calib.b ? "Click the second point." : <>Measured <span className="font-mono tabular">{measured.toFixed(2)} m</span> on the plan.</>}
            </p>
            <Button variant="ghost" size="icon-sm" onClick={cancel} aria-label="Cancel calibration"><X /></Button>
          </div>
          {calib.a && calib.b && (
            <form className="grid grid-cols-[1fr_auto] items-end gap-2" onSubmit={e => { e.preventDefault(); apply(); }}>
              <div className="grid gap-1.5">
                <Label htmlFor="ul-real" className="text-xs text-muted-foreground">Real distance</Label>
                <div className="relative">
                  <input
                    id="ul-real" inputMode="decimal" autoFocus value={real} onChange={e => setReal(e.target.value)} placeholder="e.g. 120"
                    className="h-8 w-full rounded-md border bg-background px-2.5 pr-7 font-mono text-sm tabular outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                  <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">m</span>
                </div>
              </div>
              <Button type="submit" size="sm" className="h-8" disabled={!(Number(real.replace(",", ".")) > 0)}>Apply</Button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">Click again to start over · Esc to cancel</p>
        </div>
      )}
    </Section>
  );
}
