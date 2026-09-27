/** Loads the reference image for the open plan and handles uploads. */
import { Subject } from "subjecto";
import { UNDERLAY_MAX_BYTES, UNDERLAY_MIMES, underlayUrl, type Underlay } from "@/lib/underlay";
import { setUnderlay, ui, underlay$ } from "./store";
import { viewport } from "./commands";

/** the decoded image for `underlay$` (null while loading or when there is none) */
export const underlayImg$ = new Subject<HTMLImageElement | null>(null, { name: "underlayImg", updateIfStrictlyEqual: false });

let started = false;
let currentKey = "";
/** object URL of the last uploaded file (kept alive while the thumbnail may show it) */
let localUrl: string | null = null;

function load(key: string, src: string) {
  currentKey = key;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => { if (currentKey === key) underlayImg$.next(img); };
  img.onerror = () => { if (currentKey === key) underlayImg$.next(null); };
  img.src = src;
}

export function startUnderlayImage() {
  if (started) return;
  started = true;
  underlay$.subscribe(u => {
    const planId = ui.getValue().planId;
    if (!u) { currentKey = ""; if (underlayImg$.getValue()) underlayImg$.next(null); return; }
    const key = `${planId}:${u.v}`;
    if (key === currentKey) return;
    underlayImg$.next(null);
    load(key, underlayUrl(planId, u.v));
  });
}

const MAX_SIDE = 8192;

/** Re-encodes when the image is too large or in a format the server doesn't take. */
async function prepare(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  let { width: w, height: h } = bmp;
  const tooBig = Math.max(w, h) > MAX_SIDE;
  const okType = (UNDERLAY_MIMES as readonly string[]).includes(file.type);
  if (!tooBig && okType && file.size <= UNDERLAY_MAX_BYTES) { bmp.close(); return { blob: file, w, h }; }
  const k = tooBig ? MAX_SIDE / Math.max(w, h) : 1;
  w = Math.round(w * k); h = Math.round(h * k);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/webp", 0.9));
  if (!blob) throw new Error("Couldn't convert the image");
  return { blob, w, h };
}

/**
 * Uploads a reference image. A new image is fitted to the current view; a replacement keeps
 * the previous position, rotation and on-ground width so an existing calibration roughly holds.
 */
export async function uploadUnderlay(planId: string, file: File): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPEG or WebP).");
  const { blob, w, h } = await prepare(file);
  const res = await fetch(`/api/plans/${planId}/underlay`, { method: "PUT", body: blob, headers: { "Content-Type": blob.type || "application/octet-stream" } });
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => null);
    throw new Error(msg ?? `Upload failed (${res.status})`);
  }
  const { v } = (await res.json()) as { v: number };
  const prev = underlay$.getValue();
  const next: Underlay = prev
    ? { ...prev, name: file.name, w, h, mpp: (prev.w * prev.mpp) / w, v, visible: true }
    : {
        name: file.name, w, h, v,
        x: Math.round(viewport.cx), y: Math.round(viewport.cy),
        mpp: Math.min((viewport.wm * 0.9) / w, (viewport.hm * 0.9) / h),
        rot: 0, opacity: 0.6, visible: true, locked: false, in3d: true,
      };
  // show the local copy immediately instead of re-downloading it
  const key = `${planId}:${v}`;
  currentKey = key;
  if (localUrl) URL.revokeObjectURL(localUrl);
  const url = (localUrl = URL.createObjectURL(blob));
  const img = new Image();
  img.onload = () => { if (currentKey === key) underlayImg$.next(img); };
  img.src = url;
  setUnderlay(next);
}

export async function removeUnderlay(planId: string): Promise<void> {
  const res = await fetch(`/api/plans/${planId}/underlay`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Couldn't remove the image (${res.status})`);
  setUnderlay(null);
}
