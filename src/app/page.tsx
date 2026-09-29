import { Earth, Plus } from "lucide-react";
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
      </main>
    </>
  );
}
