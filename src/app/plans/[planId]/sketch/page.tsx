import type { Metadata } from "next";
import { renderSketchPage, sketchPageMetadata } from "./render";

export async function generateMetadata({ params }: PageProps<"/plans/[planId]/sketch">): Promise<Metadata> {
  const { planId } = await params;
  return sketchPageMetadata(planId);
}

/** the sketch open (its address then shows which: /plans/<plan>/sketch/<sketch>) */
export default async function PlanSketchPage({ params }: PageProps<"/plans/[planId]/sketch">) {
  const { planId } = await params;
  return renderSketchPage(planId);
}
