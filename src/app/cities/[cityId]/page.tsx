import { notFound } from "next/navigation";
import { Earth, Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NewPlanDialog } from "@/components/plans/new-plan-dialog";
import { EngineBadge, PlanCardActions, PlanLink, PlanMeta } from "@/components/plans/plan-card";
import { PlanThumb } from "@/components/plans/plan-thumb";
import { AccessBadge } from "@/components/cities/city-card";
import { ShareButton } from "@/components/cities/share-button";
import { DuplicateCityButton } from "@/components/cities/duplicate-city-button";
import { OsmImportDialog } from "@/components/osm/osm-import-dialog";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { getCity } from "@/server/queries";
import { tryDb } from "@/server/db-status";
import { requireUser } from "@/server/auth";

export default async function CityPage({ params }: PageProps<"/cities/[cityId]">) {
  const { cityId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(cityId)) notFound();
  const res = await tryDb(async () => getCity(cityId, await requireUser()));
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const data = res.data;
  if (!data) notFound();
  const { city, plans, access, owner, ownerIsMe } = data;
  const canEdit = access !== "read";
  return (
    <>
      <AppHeader crumbs={[{ label: city.name }]}>
        <DuplicateCityButton city={{ id: city.id, name: city.name }} label={ownerIsMe ? "Duplicate" : "Make my own copy"} />
        {access === "owner" && <ShareButton city={{ id: city.id, name: city.name }} />}
        {canEdit && <OsmImportDialog mode={{ kind: "plan", cityId: city.id }} trigger={<Button size="sm" variant="outline"><Earth /> Import from map</Button>} />}
        {canEdit && <NewPlanDialog cityId={city.id} trigger={<Button size="sm"><Plus /> New plan</Button>} />}
      </AppHeader>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{city.name}</h1>
            <AccessBadge access={access} />
          </div>
          {!ownerIsMe && owner && <p className="text-sm text-muted-foreground">Owned by {owner}</p>}
          {city.description && <p className="max-w-2xl text-sm text-muted-foreground">{city.description}</p>}
        </div>
        {plans.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-20 text-center">
            <p className="mb-1 font-medium">No plans yet</p>
            {canEdit ? (
              <>
                <p className="mb-4 max-w-sm text-sm text-muted-foreground">Start blank to draw streets from scratch, from the sample district to try the simulator, or import the real streets from OpenStreetMap.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <NewPlanDialog cityId={city.id} trigger={<Button><Plus /> New plan</Button>} />
                  <OsmImportDialog mode={{ kind: "plan", cityId: city.id }} trigger={<Button variant="outline"><Earth /> Import from map</Button>} />
                </div>
              </>
            ) : <p className="max-w-sm text-sm text-muted-foreground">The owner hasn&apos;t added any plans yet.</p>}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map(p => (
              <Card key={p.id} className="relative gap-3 py-4 transition-shadow hover:shadow-md">
                <div className="px-4"><PlanThumb network={p.network} sketch={p.engine === "v2" ? p.sketch : undefined} className="aspect-[16/10]" /></div>
                <div className="flex items-start gap-2 px-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <div className="truncate font-medium"><PlanLink id={p.id}>{p.name}</PlanLink></div>
                      <EngineBadge engine={p.engine} />
                    </div>
                    <p className="line-clamp-1 min-h-5 text-sm text-muted-foreground">{p.description || " "}</p>
                  </div>
                  {canEdit && <div className="relative z-10"><PlanCardActions plan={p} canDelete={access === "owner"} /></div>}
                </div>
                <div className="px-4"><PlanMeta nodes={p.nodes} links={p.links} stops={p.stops} updatedAt={p.updatedAt} sketch={p.engine === "v2" ? p.sketch : undefined} /></div>
              </Card>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
