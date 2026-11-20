import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Download, ExternalLink, Map } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { basePath } from "@/lib/base-path";
import { requireUser } from "@/server/auth";
import { CITY_ID, REPORT_FILE, VIDEO_FILE, sizeOf } from "./files";

export const metadata: Metadata = { title: "Deep-learning city experiment — Gridlock" };

const RESULTS = [
  { name: "Neural-network search, best", score: "0.691", corridor: "−3%", centre: "−59%", trips: "+1.5%" },
  { name: "Genetic algorithm, best", score: "0.852", corridor: "−25%", centre: "−5%", trips: "+1.4%" },
  { name: "The two combined", score: "0.709", corridor: "−1%", centre: "−57%", trips: "+4%" },
];

// The deep-learning experiment (ticket #277): its explainer video and its report, both from docs/experiments/dl-city-277.
export default async function DlCityExperiment() {
  await connection();
  await requireUser();
  const [video, report] = await Promise.all([sizeOf(VIDEO_FILE), sizeOf(REPORT_FILE)]);
  const base = `${basePath}/experiments/dl-city-277`;
  return (
    <>
      <AppHeader crumbs={[{ label: "Experiments" }, { label: "Deep-learning city" }]} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6 max-w-3xl">
          <div className="mb-2 flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Can deep learning redesign a town’s streets?</h1>
            <Badge variant="secondary">#277</Badge>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            A random city with Bistrița Auto Search’s traits, an evening peak in the V2 simulator, and two searches for the best
            street layout on the same budget of 282 runs: a plain genetic algorithm, and one guided by neural networks that learn
            to predict the simulator. The aim: a quicker main road from south-west to north-east and less traffic in the centre,
            with four lanes on two main streets at most.
          </p>
        </div>

        {video !== null ? (
          <video controls preload="metadata" playsInline className="aspect-video w-full rounded-xl border bg-black" src={`${base}/video`}>
            <a href={`${base}/video`}>Download the video (WebM)</a>
          </video>
        ) : (
          <div className="grid aspect-video w-full place-items-center rounded-xl border border-dashed text-sm text-muted-foreground">
            The video hasn’t been made on this server yet (scripts/dl-city-video.ts).
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {report !== null && (
            <Button asChild>
              <a href={`${base}/report`} target="_blank" rel="noopener">
                <ExternalLink /> Open the full report
              </a>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={`/cities/${CITY_ID}`}>
              <Map /> The city and its four plans
            </Link>
          </Button>
          {video !== null && (
            <Button asChild variant="outline">
              <a href={`${base}/video`} download="dl-city-277.webm">
                <Download /> Download the video ({(video / 1e6).toFixed(0)} MB)
              </a>
            </Button>
          )}
        </div>

        <section className="mt-10 max-w-3xl">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">What came out</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Each design’s mean over five seeds. The score is half the main road’s trip time and half the centre’s traffic, both
            against today’s (today scores 1; lower is better), with penalties for trips lost or slowed.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Design</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 text-right font-medium">Main road</th>
                  <th className="px-3 py-2 text-right font-medium">Centre traffic</th>
                  <th className="px-3 py-2 text-right font-medium">Trips an hour</th>
                </tr>
              </thead>
              <tbody>
                {RESULTS.map(r => (
                  <tr key={r.name} className="border-t">
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.score}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.corridor}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.centre}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.trips}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The score leaves out cars stuck at the end and collisions, and both rose with the networks’ best design (100 stuck
            against 42 today, 17 collisions a run against 6). Look at its junctions in the editor before taking it further.
          </p>
        </section>
      </main>
    </>
  );
}
