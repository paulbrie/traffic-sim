import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Download, ExternalLink, Map } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { basePath } from "@/lib/base-path";
import { DOWNLOAD_NAME } from "@/lib/experiments/tomtom-321/download";
import { requireUser } from "@/server/auth";
import { PLAN_ID, REPORT_FILE, sizeOf } from "./files";

export const metadata: Metadata = { title: "Traffic from TomTom, and the centre's one-way streets — Gridlock" };

const INFERRED = [
  { name: "Morning peak", hour: "07:30–08:30", total: "5,382", start: "0.202, 0.25", fitted: "0.193, 0.32" },
  { name: "Evening peak", hour: "16:00–17:00", total: "5,261", start: "0.187, 0.23", fitted: "0.177, 0.29" },
];
const CHANGE = [
  { what: "Delay in the centre", morning: "−12%", evening: "−11%" },
  { what: "Traffic in the centre (vehicle-km)", morning: "−3%", evening: "−8%" },
  { what: "Time per trip across the town", morning: "+6 s", evening: "+5 s" },
  { what: "Collisions a run", morning: "9.3 → 8.5", evening: "3.3 → 6.2" },
];

// The TomTom experiment (ticket #321): its printable report, from docs/experiments/tomtom-321.
export default async function TomTomExperiment() {
  await connection();
  await requireUser();
  const report = await sizeOf(REPORT_FILE);
  const base = `${basePath}/experiments/tomtom-321`;
  return (
    <>
      <AppHeader crumbs={[{ label: "Experiments" }, { label: "Traffic from TomTom" }]} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6 max-w-3xl">
          <div className="mb-2 flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Bistrița’s peak-hour traffic from TomTom, and one-way streets for the centre</h1>
            <Badge variant="secondary">#321</Badge>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            TomTom records how fast traffic moves on each street, not how many cars there are. The morning’s and the evening’s
            traffic on “Bistrița Auto Search” were inferred from a week of TomTom’s speeds by fitting a demand in the V2
            simulator until its streets slowed where TomTom’s do. On that traffic, the centre’s streets were made one-way,
            two-way or turned round one at a time, to find what takes delay out of the centre.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {report !== null ? (
            <>
              <Button asChild>
                <a href={`${base}/report`} target="_blank" rel="noopener">
                  <ExternalLink /> Open the full report
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={`${base}/report?download`} download={DOWNLOAD_NAME}>
                  <Download /> Download the report ({Math.max(1, Math.round(report / 1e3))} KB)
                </a>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">The report hasn’t been built on this server (scripts/tomtom-321-report.ts).</p>
          )}
          <Button asChild variant="outline">
            <Link href={`/plans/${PLAN_ID}`}>
              <Map /> The plan
            </Link>
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">The report prints on A4: open it and use its “Print or save as PDF” button.</p>

        <section className="mt-10 max-w-3xl">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">The traffic inferred</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Vehicles an hour coming into the plan, and how well the simulation’s slowdowns match TomTom’s on roads the fitting
            never saw (RMSE of the share of free flow, and correlation), at the start and fitted.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Peak</th>
                  <th className="px-3 py-2 text-right font-medium">Vehicles an hour</th>
                  <th className="px-3 py-2 text-right font-medium">Held-out roads, start</th>
                  <th className="px-3 py-2 text-right font-medium">Fitted</th>
                </tr>
              </thead>
              <tbody>
                {INFERRED.map(r => (
                  <tr key={r.name} className="border-t">
                    <td className="px-3 py-2">{r.name} <span className="text-muted-foreground">{r.hour}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.total}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.start}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.fitted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10 max-w-3xl">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">The change found: Str. Ecaterina Teodoroiu one-way, southbound</h2>
          <p className="mb-4 text-sm text-muted-foreground">Against today’s layout, the mean over six fresh runs a peak.</p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 text-right font-medium">Morning</th>
                  <th className="px-3 py-2 text-right font-medium">Evening</th>
                </tr>
              </thead>
              <tbody>
                {CHANGE.map(r => (
                  <tr key={r.what} className="border-t">
                    <td className="px-3 py-2">{r.what}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.morning}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.evening}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The evening gain shows on every run; the morning varies from +13% to −41% by run. Evening collisions and stalls rise
            in the simulation, so look at the street’s two ends before building it.
          </p>
        </section>
      </main>
    </>
  );
}
