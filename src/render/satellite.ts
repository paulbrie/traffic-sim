/**
 * Satellite imagery (Esri World Imagery) under plans that know where they are on Earth (`net.geo`,
 * set by the OpenStreetMap import). Tiles are Web Mercator; over a city the difference to the
 * plan's local projection is negligible, so each tile is drawn as the rectangle between its
 * projected corners.
 */
import type { GeoRef, Vec } from "@/engine/types";
import { project } from "@/lib/osm/area";

export const SAT_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const tileUrl = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const MAX_Z = 19;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

/** latitude / longitude of a plan point (inverse of `project`) */
function unproj(geo: GeoRef, p: Vec) {
  const R = 6378137;
  return { lat: geo.lat - (p.y / R) * (180 / Math.PI), lon: geo.lon + (p.x / (R * Math.cos((geo.lat * Math.PI) / 180))) * (180 / Math.PI) };
}

/**
 * Where Esri has no imagery at a zoom it still answers, with a flat grey (204) "Map data not yet
 * available" tile. Such tiles are treated as missing, so a coarser tile is stretched instead.
 */
let probe: CanvasRenderingContext2D | null = null;
function isPlaceholder(im: HTMLImageElement) {
  try {
    probe ??= Object.assign(document.createElement("canvas"), { width: 16, height: 16 }).getContext("2d", { willReadFrequently: true });
    if (!probe) return false;
    probe.clearRect(0, 0, 16, 16);
    probe.drawImage(im, 0, 0, 16, 16);
    const d = probe.getImageData(0, 0, 16, 16).data;
    // light neutral grey, all the same shade (browsers may shift 204 a little with colour management)
    const vals: number[] = [];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - g) <= 6 && Math.abs(g - b) <= 6 && r >= 175 && r <= 230) vals.push(r);
    }
    if (vals.length < 200) return false;
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return vals.filter(v => Math.abs(v - mean) <= 6).length >= 200;
  } catch { return false; }
}

/** answer of `TileCache.get` for a tile Esri has no imagery for */
const BLANK = "blank" as const;

/** loaded tiles (most recently used last); a handful of hundred is plenty for one view */
class TileCache {
  private tiles = new Map<string, HTMLImageElement>();
  private blank = new Set<string>();
  private loading = 0;
  constructor(private max = 600) {}
  /** the tile if loaded (`BLANK` if it has no imagery); otherwise starts loading it and calls `onLoad` when it arrives */
  get(z: number, x: number, y: number, onLoad: () => void, start = true): HTMLImageElement | typeof BLANK | null {
    const k = `${z}/${x}/${y}`;
    if (this.blank.has(k)) return BLANK;
    const img = this.tiles.get(k);
    if (img) {
      this.tiles.delete(k); this.tiles.set(k, img);
      return img.complete && img.naturalWidth ? img : null;
    }
    if (!start || this.loading > 24) return null;
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.decoding = "async";
    this.loading++;
    im.onload = () => {
      this.loading--;
      if (isPlaceholder(im)) { this.tiles.delete(k); this.blank.add(k); }
      onLoad();
    };
    im.onerror = () => { this.loading--; };
    im.src = tileUrl(z, x, y);
    this.tiles.set(k, im);
    while (this.tiles.size > this.max) this.tiles.delete(this.tiles.keys().next().value!);
    return null;
  }
}
const cache = new TileCache();

/**
 * Draws the imagery for the visible world rectangle. `ctx` must already be in world coordinates
 * (1 unit = 1 m); `pxPerM` is device pixels per metre, used to pick the tile zoom.
 */
export function drawSatellite(ctx: CanvasRenderingContext2D, geo: GeoRef, view: { minX: number; minY: number; maxX: number; maxY: number }, pxPerM: number, onLoad: () => void) {
  const m0 = 156543.034 * Math.cos((geo.lat * Math.PI) / 180); // metres per tile pixel at zoom 0
  let z = Math.max(3, Math.min(MAX_Z, Math.round(Math.log2(m0 * pxPerM))));
  const nw = unproj(geo, { x: view.minX, y: view.minY }), se = unproj(geo, { x: view.maxX, y: view.maxY });
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  // never more than ~150 tiles for one view
  for (;;) {
    x0 = Math.floor(lon2x(nw.lon, z)); x1 = Math.floor(lon2x(se.lon, z)); y0 = Math.floor(lat2y(nw.lat, z)); y1 = Math.floor(lat2y(se.lat, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 150 || z <= 3) break;
    z--;
  }
  const rect = (zz: number, x: number, y: number) => {
    const a = project(geo, y2lat(y, zz), x2lon(x, zz)), b = project(geo, y2lat(y + 1, zz), x2lon(x + 1, zz));
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };
  ctx.imageSmoothingEnabled = true;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const r = rect(z, x, y);
    const img = cache.get(z, x, y, onLoad);
    if (img && img !== BLANK) { ctx.drawImage(img, r.x, r.y, r.w + 0.05, r.h + 0.05); continue; }
    // not there yet, or no imagery at this zoom: stretch the part of a coarser tile (loading the
    // coarser ones too when this zoom has none here)
    let load = img === BLANK;
    for (let up = 1; up <= 6 && z - up >= 0; up++) {
      const zz = z - up, px = x >> up, py = y >> up, parent = cache.get(zz, px, py, onLoad, load);
      if (parent === BLANK) { load = true; continue; }
      load = false;
      if (!parent) continue;
      const f = 256 >> up, sx = (x - (px << up)) * f, sy = (y - (py << up)) * f;
      ctx.drawImage(parent, sx, sy, f, f, r.x, r.y, r.w + 0.05, r.h + 0.05);
      break;
    }
  }
}

/**
 * One image of the imagery over a world rectangle (for the 3D ground), at most `maxPx` wide.
 * Resolves with the canvas and the world rectangle it covers (tile-aligned, so a bit larger).
 */
export async function satelliteMosaic(geo: GeoRef, area: { minX: number; minY: number; maxX: number; maxY: number }, maxPx = 4096): Promise<{ canvas: HTMLCanvasElement; rect: { minX: number; minY: number; maxX: number; maxY: number } } | null> {
  const nw = unproj(geo, { x: area.minX, y: area.minY }), se = unproj(geo, { x: area.maxX, y: area.maxY });
  let z = MAX_Z, x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (; z > 3; z--) {
    x0 = Math.floor(lon2x(nw.lon, z)); x1 = Math.floor(lon2x(se.lon, z)); y0 = Math.floor(lat2y(nw.lat, z)); y1 = Math.floor(lat2y(se.lat, z));
    if (Math.max(x1 - x0 + 1, y1 - y0 + 1) * 256 <= maxPx) break;
  }
  const canvas = document.createElement("canvas");
  canvas.width = (x1 - x0 + 1) * 256; canvas.height = (y1 - y0 + 1) * 256;
  const g = canvas.getContext("2d")!;
  const load = (zz: number, x: number, y: number) => new Promise<HTMLImageElement | null>(res => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(isPlaceholder(im) ? null : im);
    im.onerror = () => res(null);
    im.src = tileUrl(zz, x, y);
  });
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push((async () => {
      // no imagery at this zoom: the matching part of the nearest coarser tile that has some
      for (let up = 0; up <= 6 && z - up >= 0; up++) {
        const im = await load(z - up, x >> up, y >> up);
        if (!im) continue;
        const f = 256 >> up;
        g.drawImage(im, (x - ((x >> up) << up)) * f, (y - ((y >> up) << up)) * f, f, f, (x - x0) * 256, (y - y0) * 256, 256, 256);
        return;
      }
    })());
  }
  await Promise.all(jobs);
  const a = project(geo, y2lat(y0, z), x2lon(x0, z)), b = project(geo, y2lat(y1 + 1, z), x2lon(x1 + 1, z));
  return { canvas, rect: { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y } };
}
