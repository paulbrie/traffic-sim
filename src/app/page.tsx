import Link from "next/link";
import { Earth, FlaskConical, Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { CityCard } from "@/components/cities/city-card";
import { CityDialog } from "@/components/cities/city-dialog";
import { OsmImportDialog } from "@/components/osm/osm-import-dialog";
import { Button } from "@/components/ui/button";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { listCities } from "@/server/queries";
import { tryDb } from "@/server/db-status";
import { requireUser } from "@/server/auth";

export default async function Home() {
  const res = await tryDb(async () => listCities(await requireUser()));
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const { mine, shared } = res.data;
  return (
    <>
      <AppHeader>
        <OsmImportDialog mode={{ kind: "city" }} trigger={<Button size="sm" variant="outline"><Earth /> Import from map</Button>} />
        <CityDialog trigger={<Button size="sm"><Plus /> New city</Button>} />
      </AppHeader>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">My cities</h1>
          <p className="text-sm text-muted-foreground">Each city holds the road plans you design and simulate for it. Share a city to let others view or edit it.</p>
        </div>
        {mine.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-20 text-center">
            <p className="mb-1 font-medium">No cities yet</p>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">Create a city, then add plans to draw its streets lane by lane and run traffic through them, or import a real one from OpenStreetMap.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <CityDialog trigger={<Button><Plus /> Create your first city</Button>} />
              <OsmImportDialog mode={{ kind: "city" }} trigger={<Button variant="outline"><Earth /> Import from map</Button>} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {mine.map(c => <CityCard key={c.id} city={c} />)}
          </div>
        )}
        {shared.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-1 text-lg font-semibold tracking-tight">Shared with me</h2>
            <p className="mb-4 text-sm text-muted-foreground">Cities other people gave you access to.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {shared.map(c => <CityCard key={c.id} city={c} />)}
            </div>
          </section>
        )}
        <section className="mt-10">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">Experiments</h2>
          <p className="mb-4 text-sm text-muted-foreground">Studies run on the simulator, with what they found.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Link href="/experiments/dl-city-277" className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/50">
              <p className="mb-1 flex items-center gap-2 font-medium"><FlaskConical className="size-4" /> Deep-learning city <span className="text-xs text-muted-foreground">#277</span></p>
              <p className="text-sm text-muted-foreground">Can neural networks find a better street layout than a genetic algorithm? A video and the full report.</p>
            </Link>
            <Link href="/experiments/tomtom-321" className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/50">
              <p className="mb-1 flex items-center gap-2 font-medium"><FlaskConical className="size-4" /> Traffic from TomTom <span className="text-xs text-muted-foreground">#321</span></p>
              <p className="text-sm text-muted-foreground">Bistrița’s peak-hour traffic inferred from TomTom’s speeds, and which of the centre’s streets to make one-way. A printable report.</p>
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
