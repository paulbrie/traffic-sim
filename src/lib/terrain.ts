/**
 * Terrain (ticket #130): the ground's height under a V2 plan placed on the map, from AWS's open terrain tiles (Terrarium
 * encoding: SRTM and other public elevation models, about 30 m apart in most places, no key needed). Fetched once on the
 * server (src/server/terrain.ts) and kept in the sketch as a grid of heights, so runs never depend on the network.
 * Plain data and geometry, no framework (the sim and the checks use it in Node).
 *
 * Heights are metres above sea level; levels (bridges, tunnels) stay relative to the ground (see lane-sketch.ts `groundAt`).
 */
import type { GeoRef } from "@/engine/types";
import { unproject } from "@/lib/osm/area";

/**
 * A grid of ground heights over the plan: point (i, j) is at x = x0 + i·cell, y = y0 + j·cell (plan metres, x east, y
 * south), `cols` × `rows` points; heights as decimetres above `base`, little-endian unsigned 16-bit, base64 (the most
 * compact JSON there is for them, and exact to 10 cm over 6.5 km of height).
 */
export interface SketchTerrain {
  x0: number; y0: number; cell: number; cols: number; rows: number;
  /** metres: the lowest height on the grid */
  base: number;
  h: string;
  /** where from (`TERRAIN_SOURCE`) and when fetched (ISO) */
  source: string; at: string;
  /** the place on Earth it was fetched for: a sketch moved elsewhere (`geo` changed) has none that fits */
  geo: GeoRef;
}

export const TERRAIN_SOURCE = "AWS Terrain Tiles (Terrarium)";
export const TERRAIN_ATTRIBUTION = "Terrain: Mapzen / AWS Terrain Tiles (SRTM, GMTED, ETOPO1 and others)";
export const TERRARIUM_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
/** the finest grid kept (m), and the most points in one: about 6 × 6 km at 30 m */
export const MIN_CELL = 15, MAX_POINTS = 40_000;
/** metres round the lanes the grid covers */
export const TERRAIN_MARGIN = 150;
/** tiles fetched for one grid, at most */
export const MAX_TERRAIN_TILES = 64;

// ---------------------------------------------------------------- the grid

const decoded = new WeakMap<SketchTerrain, Float32Array>();
/** the grid's heights (m), row by row */
export function terrainHeights(t: SketchTerrain): Float32Array {
  let a = decoded.get(t);
  if (a) return a;
  const n = t.cols * t.rows, bytes = fromBase64(t.h);
  a = new Float32Array(n);
  for (let i = 0; i < n && 2 * i + 1 < bytes.length; i++) a[i] = t.base + (bytes[2 * i] | (bytes[2 * i + 1] << 8)) / 10;
  decoded.set(t, a);
  return a;
}

/** a grid from heights (m) at its points, row by row */
export function makeTerrain(g: { x0: number; y0: number; cell: number; cols: number; rows: number }, heights: ArrayLike<number>, geo: GeoRef, at = new Date().toISOString()): SketchTerrain {
  let base = Infinity;
  for (let i = 0; i < heights.length; i++) if (heights[i] < base) base = heights[i];
  base = Math.floor((Number.isFinite(base) ? base : 0) * 10) / 10;
  const bytes = new Uint8Array(g.cols * g.rows * 2);
  for (let i = 0; i < g.cols * g.rows; i++) {
    const d = Math.max(0, Math.min(65535, Math.round(((heights[i] ?? base) - base) * 10)));
    bytes[2 * i] = d & 255; bytes[2 * i + 1] = d >> 8;
  }
  return { ...g, base, h: toBase64(bytes), source: TERRAIN_SOURCE, at, geo: { lat: geo.lat, lon: geo.lon } };
}

/** the ground's height (m) at plan point (x, y): between the grid's points, bilinear; off the grid, its nearest edge's */
export function terrainAt(t: SketchTerrain, x: number, y: number): number {
  const H = terrainHeights(t);
  const fx = Math.max(0, Math.min(t.cols - 1, (x - t.x0) / t.cell)), fy = Math.max(0, Math.min(t.rows - 1, (y - t.y0) / t.cell));
  const i = Math.min(t.cols - 2, Math.floor(fx)), j = Math.min(t.rows - 2, Math.floor(fy));
  if (i < 0 || j < 0) return H[0] ?? 0;
  const u = fx - i, v = fy - j, k = j * t.cols + i;
  return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + t.cols] * (1 - u) + H[k + t.cols + 1] * u) * v;
}

/** the grid's highest and lowest heights (m) */
export function terrainRange(t: SketchTerrain): { min: number; max: number } {
  const H = terrainHeights(t);
  let min = Infinity, max = -Infinity;
  for (const h of H) { if (h < min) min = h; if (h > max) max = h; }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/** the grid's spacing and size for an area (plan metres): as fine as MIN_CELL, coarser to stay within MAX_POINTS */
export function gridFor(area: { minX: number; minY: number; maxX: number; maxY: number }) {
  const w = Math.max(1, area.maxX - area.minX), h = Math.max(1, area.maxY - area.minY);
  const cell = Math.max(MIN_CELL, Math.ceil(Math.sqrt((w * h) / MAX_POINTS)));
  const cols = Math.max(2, Math.ceil(w / cell) + 1), rows = Math.max(2, Math.ceil(h / cell) + 1);
  return { x0: area.minX, y0: area.minY, cell, cols, rows };
}

/** a terrain grid in the sketch's data, checked (null: not one) */
export function sanitizeTerrain(raw: unknown): SketchTerrain | null {
  const o = raw as Partial<SketchTerrain> | null;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!o || typeof o !== "object" || !n(o.x0) || !n(o.y0) || !n(o.cell) || o.cell <= 0 || !n(o.base) || typeof o.h !== "string") return null;
  if (!Number.isInteger(o.cols) || !Number.isInteger(o.rows) || o.cols! < 2 || o.rows! < 2 || o.cols! * o.rows! > MAX_POINTS * 2) return null;
  if (!o.geo || !n(o.geo.lat) || !n(o.geo.lon)) return null;
  // (the heights there must be all of them)
  if (Math.floor((o.h.replace(/=+$/, "").length * 3) / 4) < o.cols! * o.rows! * 2) return null;
  return { x0: o.x0, y0: o.y0, cell: o.cell, cols: o.cols!, rows: o.rows!, base: o.base, h: o.h, source: typeof o.source === "string" ? o.source : TERRAIN_SOURCE, at: typeof o.at === "string" ? o.at : "", geo: { lat: o.geo.lat, lon: o.geo.lon } };
}

/** the grid still fits where the sketch is on Earth (not moved since; a metre's difference allowed) */
export function terrainFits(t: SketchTerrain, geo: GeoRef | undefined): boolean {
  return !!geo && Math.abs(t.geo.lat - geo.lat) < 1e-5 && Math.abs(t.geo.lon - geo.lon) < 1e-5;
}

// ---------------------------------------------------------------- the tiles

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };

/** the zoom of the tiles for a grid `cell` m apart at latitude `lat`: a tile pixel at most half a cell (the data is no finer than zoom 15) */
export function terrainZoom(cell: number, lat: number): number {
  const m0 = 156543.034 * Math.cos((lat * Math.PI) / 180);
  return Math.max(8, Math.min(15, Math.ceil(Math.log2((2 * m0) / cell))));
}

/** where a latitude / longitude is in the tiles at zoom z: the tile, and the pixel in it (0–256) */
export function tilePixel(lat: number, lon: number, z: number) {
  const fx = lon2x(lon, z), fy = lat2y(lat, z), x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: (fx - x) * 256, py: (fy - y) * 256 };
}

/** the tiles covering a box of latitudes and longitudes at zoom z */
export function tilesCovering(south: number, west: number, north: number, east: number, z: number): { x: number; y: number }[] {
  const x0 = Math.floor(lon2x(west, z)), x1 = Math.floor(lon2x(east, z)), y0 = Math.floor(lat2y(north, z)), y1 = Math.floor(lat2y(south, z));
  const out: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x, y });
  return out;
}

/** Terrarium's height (m) of a pixel */
export const terrarium = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** a decoded tile's heights (m), 256 × 256, row by row */
export type TileHeights = Float32Array;

/** a tile's height (m) at pixel (px, py), bilinear between pixel centres */
export function tileAt(t: TileHeights, px: number, py: number): number {
  const fx = Math.max(0, Math.min(255, px - 0.5)), fy = Math.max(0, Math.min(255, py - 0.5));
  const i = Math.min(254, Math.floor(fx)), j = Math.min(254, Math.floor(fy)), u = fx - i, v = fy - j, k = j * 256 + i;
  return (t[k] * (1 - u) + t[k + 1] * u) * (1 - v) + (t[k + 256] * (1 - u) + t[k + 257] * u) * v;
}

/**
 * The grid over an area (plan metres round `geo`): its tiles as fine as the grid needs (coarser while there would be more than
 * MAX_TERRAIN_TILES), each fetched by `tile`, and every point's height read from them
 */
export async function terrainFromTiles(geo: GeoRef, area: { minX: number; minY: number; maxX: number; maxY: number }, tile: (z: number, x: number, y: number) => Promise<TileHeights>, parallel = 8): Promise<SketchTerrain> {
  const grid = gridFor(area);
  const nw = unproject(geo, { x: area.minX, y: area.minY }), se = unproject(geo, { x: area.maxX, y: area.maxY });
  let z = terrainZoom(grid.cell, geo.lat), list = tilesCovering(se.lat, nw.lon, nw.lat, se.lon, z);
  while (list.length > MAX_TERRAIN_TILES && z > 8) list = tilesCovering(se.lat, nw.lon, nw.lat, se.lon, --z);
  const got = new Map<string, TileHeights>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, async () => {
    while (next < list.length) { const t = list[next++]; got.set(`${t.x}/${t.y}`, await tile(z, t.x, t.y)); }
  }));
  const heights = new Float32Array(grid.cols * grid.rows);
  for (let j = 0; j < grid.rows; j++) for (let i = 0; i < grid.cols; i++) {
    const ll = unproject(geo, { x: grid.x0 + i * grid.cell, y: grid.y0 + j * grid.cell }), p = tilePixel(ll.lat, ll.lon, z), t = got.get(`${p.x}/${p.y}`);
    heights[j * grid.cols + i] = t ? tileAt(t, p.px, p.py) : 0;
  }
  return makeTerrain(grid, heights, geo);
}

// ---------------------------------------------------------------- PNG (Terrarium's: 8 bits a channel, RGB or RGBA, not interlaced)

/** a Terrarium PNG's heights; `inflate` unpacks zlib data (node:zlib's inflateSync on the server) */
export function decodeTerrariumPng(png: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): TileHeights {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const u32 = (i: number) => ((png[i] << 24) | (png[i + 1] << 16) | (png[i + 2] << 8) | png[i + 3]) >>> 0;
  let w = 0, h = 0, ch = 0;
  const idat: Uint8Array[] = [];
  for (let i = 8; i + 8 <= png.length;) {
    const n = u32(i), type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]), d = png.subarray(i + 8, i + 8 + n);
    if (type === "IHDR") {
      w = u32(i + 8); h = u32(i + 12);
      const depth = d[8], color = d[9], interlace = d[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error(`unexpected PNG format (depth ${depth}, colour ${color}, interlace ${interlace})`);
      ch = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    i += 12 + n;
  }
  if (w !== 256 || h !== 256 || !ch) throw new Error(`unexpected tile size ${w} × ${h}`);
  const z = new Uint8Array(idat.reduce((a, d) => a + d.length, 0));
  let o = 0;
  for (const d of idat) { z.set(d, o); o += d.length; }
  const raw = inflate(z), stride = w * ch, px = new Uint8Array(stride * h);
  if (raw.length < (stride + 1) * h) throw new Error("PNG data cut short");
  // (each row's filter undone: none, sub, up, average, Paeth)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0, r = raw[src + x];
      let v = r;
      if (f === 1) v = r + a;
      else if (f === 2) v = r + b;
      else if (f === 3) v = r + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + x] = v & 255;
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = terrarium(px[i * ch], px[i * ch + 1], px[i * ch + 2]);
  return out;
}

// ---------------------------------------------------------------- base64 (browser and Node alike)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return s;
}
function fromBase64(s: string): Uint8Array {
  const t = s.replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < t.length; i += 4) {
    const n = (B64.indexOf(t[i]) << 18) | (B64.indexOf(t[i + 1]) << 12) | ((i + 2 < t.length ? B64.indexOf(t[i + 2]) : 0) << 6) | (i + 3 < t.length ? B64.indexOf(t[i + 3]) : 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
