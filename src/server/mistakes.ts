// Mistakes the type checker catches (gdp-ts): every line under `@ts-expect-error` must fail to compile, so
// if one ever compiles — a sensitive function lost its proof parameter, a proof got weaker — `tsc` fails here.
// Type-checked only: nothing imports this file and it never runs. Add the mistake you almost made.
import "server-only";
import { name } from "@gdp-ts/core";
import { CityId, PlanId, UserId, VersionId, type ViewerId } from "@/lib/ids";
import { cityAccess } from "./proofs/city-access";
import { planAccess } from "./proofs/plan-access";
import { userIsAdmin } from "./proofs/user-is-admin";
import { versionOfPlan } from "./proofs/version-of-plan";
import { canEditPlan, canOwnPlan } from "./proofs/policy";
import * as cities from "./data/cities";
import * as plans from "./data/plans";
import * as users from "./data/users";

export async function mistakes(viewer: ViewerId, someone: string, cityId: string, planId: string, otherPlanId: string, versionId: string) {
  await name(viewer, PlanId(planId), PlanId(otherPlanId), async (user, plan, other) => {
    const view = await planAccess(user, plan);
    const edit = canEditPlan(view), own = canOwnPlan(view);
    const otherEdit = canEditPlan(await planAccess(user, other));
    if (!view || !edit || !own || !otherEdit) return;

    // @ts-expect-error no proof at all
    await plans.savePlan(plan, user, { network: null, settings: null, revision: 1 });
    // @ts-expect-error a proof about another plan
    await plans.savePlan(plan, user, { network: null, settings: null, revision: 1 }, otherEdit);
    if (view.kind === "UserCanViewPlan") {
      // @ts-expect-error only allowed to look: editing needs more
      await plans.savePlan(plan, user, { network: null, settings: null, revision: 1 }, view);
    }
    // @ts-expect-error a raw id, not the plan the proof is about
    await plans.getPlan(PlanId(planId), view);
    // @ts-expect-error deleting a plan (and its history) takes the map's owner, not an editor
    await plans.deletePlan(plan, edit);
    // @ts-expect-error a city's id where a plan is wanted
    await plans.getPlanImage(CityId(cityId), view);
    await plans.deletePlan(plan, own); // (this one is right)
  });

  // @ts-expect-error any account's id is not the signed-in user's: it can't be named as the one asking
  await name(UserId(someone), PlanId(planId), async (user, plan) => planAccess(user, plan));

  await name(viewer, CityId(cityId), async (user, city) => {
    const view = await cityAccess(user, city);
    if (!view) return;
    // @ts-expect-error sharing a map takes its owner
    await cities.shareCity(city, "x@y.z", "read", view);
    // @ts-expect-error a copy is owned by the user the proof is about, not anyone named
    await name(viewer, async other => cities.duplicateCity(city, other, null, view));
  });

  await name(viewer, PlanId(planId), VersionId(versionId), async (user, plan, version) => {
    const edit = canEditPlan(await planAccess(user, plan));
    if (!edit) return;
    // @ts-expect-error restoring a version takes proof that it is this plan's
    await plans.restorePlanVersion(plan, version, user, { edit });
    await name(PlanId(planId), async elsewhere => {
      const ofOther = await versionOfPlan(version, elsewhere);
      if (!ofOther) return;
      // @ts-expect-error … this plan's, not another's
      await plans.restorePlanVersion(plan, version, user, { edit, version: ofOther });
    });
  });

  await name(viewer, async user => {
    // @ts-expect-error managing accounts takes an admin
    await users.listUsers(null);
    const admin = await userIsAdmin(user);
    if (!admin) return;
    // @ts-expect-error the admin acting is the one the proof is about
    await name(viewer, async other => users.deleteUser(UserId(someone), other, admin));
  });

  // @ts-expect-error names and proofs can't leave the callback they were made in
  const leaked = name(viewer, PlanId(planId), async (user, plan) => ({ plan, proof: await planAccess(user, plan) }));
  void leaked;
}
