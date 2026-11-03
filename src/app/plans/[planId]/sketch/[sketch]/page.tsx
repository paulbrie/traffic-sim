import type { Metadata } from "next";
import { renderSketchPage, sketchPageMetadata } from "../render";

// (ticket #120: a sketch's own address, by its name: /plans/<plan>/sketch/var-800-800-100-100)
type Props = { params: Promise<{ planId: string; sketch: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { planId, sketch } = await params;
  return sketchPageMetadata(planId, sketch);
}

export default async function PlanSketchByNamePage({ params }: Props) {
  const { planId, sketch } = await params;
  return renderSketchPage(planId, sketch);
}
