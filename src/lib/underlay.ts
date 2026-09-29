import { basePath } from "./base-path";

/**
 * Reference image placed under the plan (a map screenshot, an aerial photo, a survey drawing).
 * The image bytes live in `plan_images`; this transform lives on the plan row and autosaves with it.
 */
export interface Underlay {
  /** original file name, for display */
  name: string;
  /** image size in pixels */
  w: number;
  h: number;
  /** world position of the image centre, metres */
  x: number;
  y: number;
  /** metres per image pixel */
  mpp: number;
  /** clockwise rotation, degrees */
  rot: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** show the image on the 3D ground too */
  in3d: boolean;
  /** image version, bumped on every upload (cache key) */
  v: number;
}

export const UNDERLAY_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const UNDERLAY_MAX_BYTES = 25 * 1024 * 1024;

const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export function sanitizeUnderlay(input: unknown): Underlay | null {
  if (!input || typeof input !== "object") return null;
  const s = input as Record<string, unknown>;
  const w = Math.round(num(s.w, 0, 20000, 0)), h = Math.round(num(s.h, 0, 20000, 0));
  if (!w || !h) return null;
  return {
    name: typeof s.name === "string" ? s.name.slice(0, 160) : "Reference image",
    w, h,
    x: num(s.x, -1e6, 1e6, 0), y: num(s.y, -1e6, 1e6, 0),
    mpp: num(s.mpp, 1e-4, 1000, 0.5),
    rot: ((num(s.rot, -1e4, 1e4, 0) % 360) + 360) % 360,
    opacity: num(s.opacity, 0.05, 1, 0.6),
    visible: s.visible !== false,
    locked: s.locked === true,
    in3d: s.in3d !== false,
    v: Math.round(num(s.v, 1, 1e12, 1)),
  };
}

/** world → image pixel coordinates (origin top-left) */
export function worldToImage(u: Underlay, p: { x: number; y: number }) {
  const a = (-u.rot * Math.PI) / 180, dx = p.x - u.x, dy = p.y - u.y;
  const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
  return { x: rx / u.mpp + u.w / 2, y: ry / u.mpp + u.h / 2 };
}

/** the four world-space corners, clockwise from top-left */
export function underlayCorners(u: Underlay) {
  const a = (u.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const hw = (u.w * u.mpp) / 2, hh = (u.h * u.mpp) / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: u.x + x * c - y * s, y: u.y + x * s + y * c }));
}

export const underlayUrl = (planId: string, v: number) => `${basePath}/api/plans/${planId}/underlay?v=${v}`;
