import { Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { CityCard } from "@/components/cities/city-card";
import { CityDialog } from "@/components/cities/city-dialog";
import { Button } from "@/components/ui/button";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { listCities } from "@/server/queries";
import { tryDb } from "@/server/db-status";
import { requireUser } from "@/server/auth";

export default async function Home() {
  const res = await tryDb(async () => { await requireUser(); return listCities(); });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const cities = res.data;
  return (
    <>
      <AppHeader>
        <CityDialog trigger={<Button size="sm"><Plus /> New city</Button>} />
      </AppHeader>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Cities</h1>
          <p className="text-sm text-muted-foreground">Each city holds the road plans you design and simulate for it.</p>
        </div>
        {cities.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-20 text-center">
            <p className="mb-1 font-medium">No cities yet</p>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">Create a city, then add plans to draw its streets lane by lane and run traffic through them.</p>
            <CityDialog trigger={<Button><Plus /> Create your first city</Button>} />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cities.map(c => <CityCard key={c.id} city={c} />)}
          </div>
        )}
      </main>
    </>
  );
}
