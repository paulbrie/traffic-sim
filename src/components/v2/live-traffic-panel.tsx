"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Gauge, History, Pause, Play, Radio, RefreshCw, StepBack, StepForward, TrafficCone, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { GeoArea } from "@/engine/types";
import type { Sketch } from "@/lib/lane-sketch";
import { freeFlowLimits, sketchArea, LIMIT_MIN_COVER, TRAFFIC_BANDS, TRAFFIC_CLOSED, TRAFFIC_NO_DATA, type FlowLine, type TrafficMatch } from "@/lib/tomtom";
import type { Incident } from "@/lib/tomtom-api";
import { cn } from "@/lib/utils";
import { basePath } from "@/lib/base-path";
import type { TrafficHistoryInfo } from "@/server/data/traffic-history";
import type { TrafficSampleInfo } from "@/server/data/traffic-samples";
import { fetchLiveTraffic, getTrafficHistoryInfo, getTrafficSamples } from "@/server/traffic";
import { useSketchStore } from "@/state/lane-sketch";
import { clearLiveTraffic, logTrafficPull, setLiveTraffic, type LiveTraffic } from "@/state/live-traffic";
import { InspectorPanel } from "./inspector-panel";

const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Live traffic from TomTom (ticket #33) for a V2 plan placed on the map: fetched on asking, kept in the page only. Shows
 * how much of the plan's roads TomTom covers, what the map's colours mean (the "Live traffic" layer), sets each covered
 * road's speed limit to its free-flow speed (one edit, undo brings it back). The incidents come with Live traffic sync
 * (Display options), on the same map layer.
 */
export function LiveTrafficPanel({ planId, sketch, live, match, readOnly }: {
  planId: string; sketch: Sketch; live: LiveTraffic | null; match: TrafficMatch | null; readOnly: boolean;
}) {
  const { edit: editSketch } = useSketchStore();
  const [busy, setBusy] = useState(false);
  const area = sketchArea(sketch);
  const fetchNow = async () => {
    if (!area) return;
    setBusy(true);
    try {
      const r = await fetchLiveTraffic(planId, area);
      if (r.ok) { setLiveTraffic(planId, r.snapshot); logTrafficPull({ what: "speeds", plan: planId, count: r.snapshot.speeds.length }); }
      else { toast.error("No live traffic", { description: r.error }); logTrafficPull({ what: "speeds", plan: planId, error: r.error }); }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      toast.error("No live traffic", { description: error });
      logTrafficPull({ what: "speeds", plan: planId, error });
    } finally { setBusy(false); }
  };
  const limits = match ? freeFlowLimits(sketch, match) : null;
  const setLimits = () => {
    if (!match) return;
    let n = 0;
    editSketch(sk => { const r = freeFlowLimits(sk, match); n = r.changed.length; return r.sketch; });
    toast.success(`Speed limits set on ${n} road${n === 1 ? "" : "s"}`, { description: "Each road's free-flow speed from TomTom, rounded to 5 km/h. Undo brings the old ones back." });
  };
  const snap = live?.snapshot;
  return (
    <InspectorPanel id="live-traffic" title="Live traffic" icon={<TrafficCone className="size-3.5 shrink-0 text-muted-foreground" />}
      actions={snap && <Button size="icon-sm" variant="ghost" aria-label="Clear the live traffic" title="Clear it (the map's colours go)" onClick={clearLiveTraffic}><X className="size-3.5" /></Button>}>
      {!area ? (
        <p className="text-[11px] text-muted-foreground">Place the plan on the map (Background) to get TomTom&apos;s live traffic for it.</p>
      ) : !snap ? (
        <>
          <p className="text-[11px] text-muted-foreground">TomTom&apos;s traffic now on the plan&apos;s roads: each road&apos;s speed, against its free-flow speed. Speeds only: TomTom doesn&apos;t count vehicles. (Jams, roadworks and closures: Live traffic sync, in Display options.)</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={fetchNow}><RefreshCw className={cn(busy && "animate-spin")} /> {busy ? "Fetching…" : "Fetch live traffic"}</Button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs">
            {live?.recorded
              ? <span title={`Recorded by the server; ${new Date(snap.at).toLocaleString()} here`}>Recorded at {utc(snap.at)} UTC</span>
              : <span title={new Date(snap.at).toLocaleString()}>TomTom at {hhmm(snap.at)} <span className="text-muted-foreground">({ago(snap.at)})</span></span>}
            <Button size="icon-sm" variant="ghost" aria-label="Fetch it again" title="Fetch it again" disabled={busy} onClick={fetchNow}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /></Button>
          </div>
          {match && (
            <p className="text-[11px] text-muted-foreground">
              Covers {match.length ? Math.round((100 * match.covered) / match.length) : 0}% of the roads&apos; lanes ({(match.covered / 1000).toFixed(1)} of {(match.length / 1000).toFixed(1)} km, {match.roads.size} roads); minor streets mostly have no data.
            </p>
          )}
          <div className="grid gap-0.5" title="The map's Live traffic layer: each lane coloured by its speed now as a share of its free-flow speed">
            <span className="text-[11px] text-muted-foreground">Speed now, of free flow:</span>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
              {[...TRAFFIC_BANDS].reverse().map(b => <span key={b.label} className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: b.color }} />{b.label}</span>)}
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: TRAFFIC_CLOSED }} />closed</span>
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: TRAFFIC_NO_DATA }} />no data</span>
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={readOnly || !limits?.changed.length} onClick={setLimits}
            title={`Each road TomTom covers at least ${Math.round(LIMIT_MIN_COVER * 100)}% of gets its free-flow speed (rounded to 5 km/h) as its speed limit, the speed the cars want there. One edit: undo brings the old limits back.`}>
            <Gauge /> Speed limits from free flow{limits ? ` (${limits.changed.length} road${limits.changed.length === 1 ? "" : "s"})` : ""}
          </Button>
        </>
      )}
      <RecordedTraffic planId={planId} live={live} onLive={fetchNow} />
      <p className="text-[10px] text-muted-foreground">Traffic data © TomTom. Kept in this page only, never saved with the plan.</p>
    </InspectorPanel>
  );
}

const utc = (iso: string) => `${new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })} ${iso.slice(11, 16)}`;

/** the replay: one sample shown every this long (ms) while playing */
const PLAY_MS = 800;
/** samples kept in the page, loaded (each ~0.3 MB once unzipped) */
const KEEP = 48;
/** a sample asked for once the slider has stopped this long (ms): dragging it doesn't load each one passed */
const SETTLE = 90;

/** a recorded sample, unzipped */
interface Loaded { at: string; area: GeoArea; incidents: Incident[]; speeds: FlowLine[]; ratios: FlowLine[] }
const loaded = new Map<string, Promise<Loaded>>();
function loadSample(planId: string, id: string): Promise<Loaded> {
  let p = loaded.get(id);
  if (!p) {
    p = fetch(`${basePath}/api/plans/${planId}/traffic/history/${id}`).then(async r => {
      if (!r.ok || !r.body) throw new Error(await r.json().then((d: { error?: string }) => d.error ?? `${r.status}`, () => `${r.status}`));
      return (await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json()) as Loaded;
    });
    // (a failed one asked again next time)
    p.catch(() => loaded.delete(id));
    loaded.set(id, p);
    while (loaded.size > KEEP) loaded.delete(loaded.keys().next().value!);
  }
  return p;
}

const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * (ticket #261) TomTom's traffic the server records for the plan (every 5 minutes in the hours set: scripts/traffic-collect.ts),
 * if it records any: how much, the last 14 days' as a file to analyse, and a replay. Nothing shown for a plan not recorded.
 */
function RecordedTraffic({ planId, live, onLive }: { planId: string; live: LiveTraffic | null; onLive: () => void }) {
  const [info, setInfo] = useState<TrafficHistoryInfo | null>(null);
  const [replay, setReplay] = useState(false);
  useEffect(() => {
    let on = true;
    getTrafficHistoryInfo(planId).then(x => { if (on) setInfo(x); }, () => {});
    return () => { on = false; };
  }, [planId]);
  if (!info?.samples || !info.first || !info.last) return null;
  const url = `${basePath}/api/plans/${planId}/traffic/history`;
  return (
    <div className="grid gap-1.5 border-t pt-2 text-[11px]">
      <span title="The server fetches TomTom's traffic for this plan every 5 minutes in the hours set, and keeps it: speeds and incidents, to analyse later.">
        Recorded: {info.samples} snapshot{info.samples === 1 ? "" : "s"}{info.ok < info.samples ? ` (${info.samples - info.ok} failed)` : ""}, {utc(info.first)} – {utc(info.last)} UTC
      </span>
      {info.lastError && <span className="text-destructive">Last one failed: {info.lastError}</span>}
      {replay
        ? <TrafficReplay planId={planId} live={live} onLive={() => { setReplay(false); onLive(); }} onClose={() => setReplay(false)} />
        : <Button size="sm" variant="outline" onClick={() => setReplay(true)} title="Show the traffic recorded on the map, one snapshot after another, as the simulation's replay"><History /> Replay recorded traffic</Button>}
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Last 14 days:</span>
        <Button asChild size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]"><a href={url} download><Download className="size-3" /> JSON</a></Button>
        <Button asChild size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]"><a href={`${url}?format=csv`} download><Download className="size-3" /> CSV</a></Button>
      </div>
    </div>
  );
}

/**
 * The recorded traffic replayed (ticket #261), as the simulation's replay: a day picked, a slider over its samples, step back
 * and forward, play (one sample every PLAY_MS); each shown on the map as live traffic is (the lanes' colours, the hover
 * cards, the incidents then). Live fetches TomTom's traffic now.
 */
function TrafficReplay({ planId, live, onLive, onClose }: { planId: string; live: LiveTraffic | null; onLive: () => void; onClose: () => void }) {
  const [samples, setSamples] = useState<TrafficSampleInfo[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** a sample that couldn't be loaded, and why */
  const [failed, setFailed] = useState<{ id: string; why: string } | null>(null);
  /** the sample last asked for (an older one coming back later isn't shown) */
  const asked = useRef<string | null>(null);
  useEffect(() => {
    let on = true;
    getTrafficSamples(planId).then(xs => {
      if (!on) return;
      setSamples(xs);
      // (the day of the sample shown, else the newest; at that sample, else its first)
      const shown = xs.find(x => x.id === live?.recorded?.id), d = (shown ?? xs.at(-1))?.at.slice(0, 10) ?? null;
      setDay(d);
      setIdx(shown ? xs.filter(x => x.at.startsWith(d!)).indexOf(shown) : 0);
    }, e => { if (on) setProblem(e instanceof Error ? e.message : String(e)); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);
  const days = useMemo(() => {
    const m = new Map<string, TrafficSampleInfo[]>();
    for (const x of samples ?? []) { const d = x.at.slice(0, 10), l = m.get(d); if (l) l.push(x); else m.set(d, [x]); }
    return m;
  }, [samples]);
  const list = (day && days.get(day)) || [];
  const cur = list[Math.min(idx, list.length - 1)];
  const shownId = live?.recorded?.id ?? null;
  // (the sample at the slider shown, once it has stopped there; the next ones loaded ahead)
  useEffect(() => {
    if (!cur) return;
    asked.current = cur.id;
    if (cur.error || cur.id === shownId) return;
    const t = setTimeout(() => {
      setBusy(true);
      loadSample(planId, cur.id).then(s => {
        if (asked.current !== cur.id) return;
        setLiveTraffic(planId, { at: s.at, area: s.area, speeds: s.speeds, ratios: s.ratios }, { id: cur.id, incidents: s.incidents });
      }, e => { if (asked.current === cur.id) { setFailed({ id: cur.id, why: e instanceof Error ? e.message : String(e) }); setPlaying(false); } })
        .finally(() => { if (asked.current === cur.id) setBusy(false); });
      for (const x of list.slice(idx + 1, idx + 3)) if (!x.error) void loadSample(planId, x.id).catch(() => {});
    }, playing ? 0 : SETTLE);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, planId]);
  // (playing: the next sample once this one is on the map, or has none)
  useEffect(() => {
    if (!playing || !cur || (!cur.error && cur.id !== shownId)) return;
    const t = setTimeout(() => { if (idx >= list.length - 1) setPlaying(false); else setIdx(i => i + 1); }, PLAY_MS);
    return () => clearTimeout(t);
  }, [playing, cur, shownId, idx, list.length]);

  if (!samples) return <p className="text-muted-foreground">{problem ?? "Loading the snapshots…"}</p>;
  if (!list.length || !cur) return <p className="text-muted-foreground">No snapshots recorded.</p>;
  const why = cur.error ? `No data at ${cur.at.slice(11, 16)} UTC: ${cur.error}` : failed?.id === cur.id ? `Couldn't load it: ${failed.why}` : null;
  const go = (i: number) => { setPlaying(false); setIdx(Math.max(0, Math.min(list.length - 1, i))); };
  return (
    <div role="group" aria-label="Replay of the recorded traffic" className="grid gap-1.5 rounded-md border p-1.5">
      <div className="flex items-center gap-1">
        <Select value={day ?? ""} onValueChange={d => { setPlaying(false); setDay(d); setIdx(0); }}>
          <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Day recorded"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[...days].reverse().map(([d, xs]) => <SelectItem key={d} value={d} className="text-xs">{dayLabel(d)} · {xs.length} snapshots</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="icon-sm" variant="ghost" aria-label="Close the replay" title="Close the replay (what is on the map stays)" onClick={() => { setPlaying(false); onClose(); }}><X className="size-3.5" /></Button>
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Step back" title="The snapshot before (5 min)" disabled={idx <= 0} onClick={() => go(idx - 1)}><StepBack /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={playing ? "Pause the replay" : "Play the replay"} title={playing ? "Pause" : `Play the day (a snapshot every ${PLAY_MS / 1000} s)`}
          onClick={() => { if (playing) { setPlaying(false); return; } if (idx >= list.length - 1) setIdx(0); setPlaying(true); }}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Step forward" title="The snapshot after (5 min)" disabled={idx >= list.length - 1} onClick={() => go(idx + 1)}><StepForward /></Button>
        <Slider className="mx-1 flex-1" min={0} max={Math.max(1, list.length - 1)} step={1} value={[Math.min(idx, list.length - 1)]} disabled={list.length < 2}
          onValueChange={([v]) => go(v)} aria-label="Snapshot recorded" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono tabular" title={`${new Date(cur.at).toLocaleString()} here · snapshot ${idx + 1} of ${list.length} that day`}>
          <span className="font-semibold text-foreground">{cur.at.slice(11, 16)}</span> UTC <span className="text-muted-foreground">· {idx + 1}/{list.length}</span>
          {busy && <RefreshCw className="ml-1 inline size-3 animate-spin text-muted-foreground" />}
        </span>
        <Button size="sm" variant={live?.recorded ? "default" : "secondary"} className="h-6 px-2 text-[11px]" onClick={() => { setPlaying(false); onLive(); }} title="Back to TomTom's traffic now (fetched again)">
          <Radio className="size-3" /> Live
        </Button>
      </div>
      {why && <span className="text-destructive">{why}</span>}
    </div>
  );
}
