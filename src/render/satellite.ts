/**
 * Satellite imagery under plans that know where they are on Earth (`net.geo`, set by the
 * OpenStreetMap import), from Esri World Imagery or, when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set,
 * Google (Map Tiles API, 2D satellite tiles: billed per thousand tiles, after a free monthly
 * allowance). Tiles are Web Mercator; over a city the difference to the plan's local projection is
 * negligible, so each tile is drawn as the rectangle between its projected corners. They are only
 * shown, never stored, with their makers' credits, as the providers' terms ask.
 */
import type { GeoRef, Vec } from "@/engine/types";
import { project } from "@/lib/osm/area";

export type SatSource = "esri" | "google";

export const SAT_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
/** Google's logo, which must be shown with its tiles */
export const GOOGLE_LOGO = "https://www.gstatic.com/images/branding/googlelogo/svg/googlelogo_clr_74x24px.svg";
/** Google imagery can be picked (the app was built with a Google Maps API key) */
export const googleImagery = !!GOOGLE_KEY;

/** Google's credits for the imagery on screen, or why it couldn't be loaded */
export type GoogleInfo = { copyright: string; error: string | null };
let googleInfo: GoogleInfo = { copyright: "", error: null };
const infoListeners = new Set<() => void>();
function setGoogleInfo(i: Partial<GoogleInfo>) {
  googleInfo = { ...googleInfo, ...i };
  infoListeners.forEach(f => f());
}
export const googleImageryInfo = {
  get: () => googleInfo,
  subscribe(f: () => void) { infoListeners.add(f); return () => { infoListeners.delete(f); }; },
};

/** a Map Tiles API session (needed in every tile URL; lasts about two weeks) */
let session: { token: string; expiry: number } | null = null;
let sessionReq: Promise<string | null> | null = null;
function googleSession(): Promise<string | null> {
  if (session && session.expiry * 1000 > Date.now() + 60_000) return Promise.resolve(session.token);
  if (googleInfo.error) return Promise.resolve(null);
  const region = (typeof navigator !== "undefined" && /-([A-Z]{2})$/.exec(navigator.language)?.[1]) || "US";
  sessionReq ??= fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(GOOGLE_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: (typeof navigator !== "undefined" && navigator.language) || "en-US", region }),
  }).then(async r => {
    if (!r.ok) {
      const msg = ((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(r.status === 403
        ? `Google refused the imagery (403)${msg ? `: ${msg}` : ""}. Check that the Map Tiles API is enabled for the key and the key allows this site.`
        : `Google's imagery couldn't be loaded (${r.status})${msg ? `: ${msg}` : ""}.`);
    }
    const j = (await r.json()) as { session: string; expiry: string };
    session = { token: j.session, expiry: Number(j.expiry) };
    return session.token;
  }).catch((e: Error) => { setGoogleInfo({ error: e.message || "Google's imagery couldn't be loaded." }); return null; })
    .finally(() => { sessionReq = null; });
  return sessionReq;
}

/** the credits Google asks to show for a view (they depend on where and how close) */
let creditKey = "", creditTimer: ReturnType<typeof setTimeout> | null = null;
function updateGoogleCredits(z: number, nw: { lat: number; lon: number }, se: { lat: number; lon: number }) {
  if (!session) return;
  const key = [z, nw.lat.toFixed(3), nw.lon.toFixed(3), se.lat.toFixed(3), se.lon.toFixed(3)].join(",");
  if (key === creditKey) return;
  creditKey = key;
  if (creditTimer) clearTimeout(creditTimer);
  creditTimer = setTimeout(() => {
    const q = new URLSearchParams({ session: session!.token, key: GOOGLE_KEY, zoom: String(z), north: String(nw.lat), south: String(se.lat), west: String(nw.lon), east: String(se.lon) });
    fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then((j: { copyright?: string } | null) => { if (j && creditKey === key) setGoogleInfo({ copyright: j.copyright ?? "" }); })
      .catch(() => {});
  }, 400);
}

type Source = {
  maxZ: number;
  /** the tile's URL; null while it can't be asked for yet (Google: no session yet) */
  url: (z: number, x: number, y: number) => string | null;
  /** answers "no imagery here" with a flat grey tile rather than an error */
  placeholders: boolean;
};
const SOURCES: Record<SatSource, Source> = {
  esri: { maxZ: 19, placeholders: true, url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
  google: { maxZ: 21, placeholders: false, url: (z, x, y) => (session ? `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${session.token}&key=${encodeURIComponent(GOOGLE_KEY)}` : null) },
};
/** the source to use: Google only when the app has a key for it */
const pick = (source: SatSource | undefined): SatSource => (source === "google" && googleImagery ? "google" : "esri");

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

/** answer of `TileCache.get` for a tile the source has no imagery for */
const BLANK = "blank" as const;

/** loaded tiles (most recently used last); a handful of hundred is plenty for one view */
class TileCache {
  private tiles = new Map<string, HTMLImageElement>();
  private blank = new Set<string>();
  private loading = 0;
  constructor(private src: Source, private max = 600) {}
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
    const url = this.src.url(z, x, y);
    if (!url) return null;
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.decoding = "async";
    this.loading++;
    im.onload = () => {
      this.loading--;
      if (this.src.placeholders && isPlaceholder(im)) { this.tiles.delete(k); this.blank.add(k); }
      onLoad();
    };
    // (Google answers 404 where it has no imagery at this zoom)
    im.onerror = () => { this.loading--; this.tiles.delete(k); this.blank.add(k); onLoad(); };
    im.src = url;
    this.tiles.set(k, im);
    while (this.tiles.size > this.max) this.tiles.delete(this.tiles.keys().next().value!);
    return null;
  }
}
const caches: Record<SatSource, TileCache> = { esri: new TileCache(SOURCES.esri), google: new TileCache(SOURCES.google) };

/**
 * Draws the imagery for the visible world rectangle. `ctx` must already be in world coordinates
 * (1 unit = 1 m); `pxPerM` is device pixels per metre, used to pick the tile zoom.
 */
export function drawSatellite(ctx: CanvasRenderingContext2D, geo: GeoRef, view: { minX: number; minY: number; maxX: number; maxY: number }, pxPerM: number, onLoad: () => void, source?: SatSource) {
  const name = pick(source), src = SOURCES[name], cache = caches[name];
  if (name === "google") {
    // (renews the session when it is about to run out)
    const had = !!session;
    void googleSession().then(t => { if (t && !had) onLoad(); });
    if (!had) return;
  }
  const m0 = 156543.034 * Math.cos((geo.lat * Math.PI) / 180); // metres per tile pixel at zoom 0
  let z = Math.max(3, Math.min(src.maxZ, Math.round(Math.log2(m0 * pxPerM))));
  const nw = unproj(geo, { x: view.minX, y: view.minY }), se = unproj(geo, { x: view.maxX, y: view.maxY });
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  // never more than ~150 tiles for one view
  for (;;) {
    x0 = Math.floor(lon2x(nw.lon, z)); x1 = Math.floor(lon2x(se.lon, z)); y0 = Math.floor(lat2y(nw.lat, z)); y1 = Math.floor(lat2y(se.lat, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 150 || z <= 3) break;
    z--;
  }
  if (name === "google") updateGoogleCredits(z, nw, se);
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
export async function satelliteMosaic(geo: GeoRef, area: { minX: number; minY: number; maxX: number; maxY: number }, maxPx = 4096, source?: SatSource): Promise<{ canvas: HTMLCanvasElement; rect: { minX: number; minY: number; maxX: number; maxY: number } } | null> {
  const name = pick(source), src = SOURCES[name];
  if (name === "google" && !(await googleSession())) return null;
  const nw = unproj(geo, { x: area.minX, y: area.minY }), se = unproj(geo, { x: area.maxX, y: area.maxY });
  let z = src.maxZ, x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (; z > 3; z--) {
    x0 = Math.floor(lon2x(nw.lon, z)); x1 = Math.floor(lon2x(se.lon, z)); y0 = Math.floor(lat2y(nw.lat, z)); y1 = Math.floor(lat2y(se.lat, z));
    if (Math.max(x1 - x0 + 1, y1 - y0 + 1) * 256 <= maxPx) break;
  }
  const canvas = document.createElement("canvas");
  canvas.width = (x1 - x0 + 1) * 256; canvas.height = (y1 - y0 + 1) * 256;
  const g = canvas.getContext("2d")!;
  const load = (zz: number, x: number, y: number) => new Promise<HTMLImageElement | null>(res => {
    const url = src.url(zz, x, y);
    if (!url) return res(null);
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(src.placeholders && isPlaceholder(im) ? null : im);
    im.onerror = () => res(null);
    im.src = url;
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
