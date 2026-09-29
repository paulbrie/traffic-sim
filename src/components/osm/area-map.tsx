"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import { Loader2, MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GeoRef } from "@/engine/types";
import type { BBox } from "@/lib/osm/area";

const VIEW_KEY = "gridlock:osm-view";
/** the import frame leaves this much of the map around it (px) */
const INSET = 36;

interface Place { display_name: string; lat: string; lon: string; boundingbox: [string, string, string, string] }

/**
 * OpenStreetMap map with a fixed frame in the middle: pan and zoom the map until the frame covers
 * the area to import. Reports the frame's bounds whenever the map moves.
 */
export function AreaMap({ center, existing, onChange, onPlace }: {
  /** where to open (otherwise the last place used, otherwise central Bucharest) */
  center?: GeoRef | null;
  /** outlines of the areas the plan already covers */
  existing?: BBox[];
  onChange: (b: BBox) => void;
  /** short name of a place picked in the search */
  onPlace?: (name: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    let cancelled = false, map: LeafletMap | null = null, ro: ResizeObserver | null = null;
    import("leaflet").then(L => {
      if (cancelled || !wrapRef.current) return;
      let view: { lat: number; lon: number; zoom: number } = { lat: 44.4355, lon: 26.1025, zoom: 15 };
      try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null"); if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.zoom)) view = v; } catch {}
      if (center) view = { lat: center.lat, lon: center.lon, zoom: 16 };
      map = L.map(wrapRef.current, { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 }).setView([view.lat, view.lon], view.zoom);
      mapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      }).addTo(map);
      for (const a of existing ?? []) {
        L.rectangle([[a.south, a.west], [a.north, a.east]], { color: "#1f7a5a", weight: 2, dashArray: "6 4", fill: true, fillOpacity: 0.08, interactive: false }).addTo(map);
      }
      const report = () => {
        if (!map || !frameRef.current || !wrapRef.current) return;
        const w = wrapRef.current.clientWidth, h = wrapRef.current.clientHeight;
        const nw = map.containerPointToLatLng([INSET, INSET]), se = map.containerPointToLatLng([w - INSET, h - INSET]);
        onChangeRef.current({ south: se.lat, west: nw.lng, north: nw.lat, east: se.lng });
        const c = map.getCenter();
        try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })); } catch {}
      };
      map.on("moveend zoomend", report);
      ro = new ResizeObserver(() => { map?.invalidateSize(); report(); });
      ro.observe(wrapRef.current);
      report();
    });
    return () => { cancelled = true; ro?.disconnect(); map?.remove(); mapRef.current = null; };
    // the map is created once; later prop changes don't move it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q.trim())}`, { headers: { Accept: "application/json" } });
      const list = (await res.json()) as Place[];
      if (list.length === 1) { go(list[0]); setResults(null); } else setResults(list);
    } catch { setResults([]); } finally { setSearching(false); }
  }
  function go(p: Place) {
    const map = mapRef.current;
    if (!map) return;
    onPlace?.(p.display_name.split(",")[0].trim());
    const [s, n, w, e] = p.boundingbox.map(Number);
    // small places (a square, a street): a neighbourhood around them; towns: their whole extent, capped by the frame size check
    if (Math.abs(n - s) < 0.01 && Math.abs(e - w) < 0.01) map.setView([Number(p.lat), Number(p.lon)], 16.5);
    else map.fitBounds([[s, w], [n, e]], { padding: [INSET, INSET], maxZoom: 16.5 });
  }

  return (
    <div className="relative h-full min-h-80 overflow-hidden rounded-lg border">
      <div ref={wrapRef} className="absolute inset-0 z-0" />
      {/* import frame: everything outside is dimmed */}
      <div ref={frameRef} className="pointer-events-none absolute z-[500] rounded-sm border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.22)]" style={{ inset: INSET }} />
      {/* not a <form>: the map sits inside the import dialog's form */}
      <div role="search" className="absolute top-2 left-1/2 z-[600] flex w-[min(26rem,calc(100%-5rem))] -translate-x-1/2 gap-1.5">
        <Input
          value={q} onChange={e => { setQ(e.target.value); setResults(null); }} placeholder="Find a place, street or address" aria-label="Find a place" className="h-8 bg-background shadow-sm"
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
        />
        <Button type="button" size="sm" variant="secondary" className="h-8 shadow-sm" disabled={searching} onClick={search} aria-label="Search">{searching ? <Loader2 className="animate-spin" /> : <Search />}</Button>
      </div>
      {results && (
        <ul className="absolute top-12 left-1/2 z-[600] max-h-60 w-[min(26rem,calc(100%-5rem))] -translate-x-1/2 overflow-y-auto rounded-md border bg-background text-sm shadow-md" role="listbox" aria-label="Places found">
          {results.length === 0 && <li className="px-3 py-2 text-muted-foreground">Nothing found.</li>}
          {results.map((p, i) => (
            <li key={i}>
              <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent" onClick={() => { go(p); setResults(null); }}>
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> <span className="line-clamp-2">{p.display_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
