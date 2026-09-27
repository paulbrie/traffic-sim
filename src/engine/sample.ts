import { DEFAULT_SIGNAL, type Control, type LinkDef, type Network, type NodeDef, type Vec } from "./types";

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function makeNode(x: number, y: number, control: Control = "priority", gateway = true): NodeDef {
  return { id: newId("n"), x, y, control, gateway, signal: { ...DEFAULT_SIGNAL } };
}

export function makeLink(from: NodeDef, to: NodeDef, lanesF = 1, lanesB = 1, extra: Partial<LinkDef> = {}): LinkDef {
  return { id: newId("l"), name: "", from: from.id, to: to.id, c1: null, c2: null, lanesF, lanesB, busF: false, busB: false, speed: 50, ...extra };
}

/** A small, deliberately irregular district: a diagonal boulevard with bus lanes,
 *  a curved street, a roundabout, a one-way pair and a bus loop. */
export function sampleTown(): Network {
  const N = (x: number, y: number, control: Control = "priority") => makeNode(x, y, control);
  const g1 = N(-340, 170), j1 = N(-160, 80, "lights"), j2 = N(0, 0, "lights"), j3 = N(170, -85, "lights"), g2 = N(340, -170);
  const g3 = N(-10, -250), j4 = N(-30, -120, "stop"), j5 = N(25, 120, "roundabout"), g4 = N(10, 260);
  const g5 = N(-340, -60), j6 = N(-165, -55), j8 = N(190, 150), g7 = N(340, 190), j9 = N(-150, 185), g6 = N(-340, 230);
  const nodes = [g1, j1, j2, j3, g2, g3, j4, j5, g4, g5, j6, j8, g7, j9, g6];

  const c = (x: number, y: number): Vec => ({ x, y });
  const links: LinkDef[] = [
    makeLink(g1, j1, 2, 2, { name: "Bulevardul Eroilor", speed: 50 }),
    makeLink(j1, j2, 3, 3, { name: "Bulevardul Eroilor", busF: true, busB: true, speed: 50 }),
    makeLink(j2, j3, 3, 3, { name: "Bulevardul Eroilor", busF: true, busB: true, speed: 50 }),
    makeLink(j3, g2, 2, 2, { name: "Bulevardul Eroilor", speed: 60 }),
    makeLink(g3, j4, 1, 1, { name: "Strada Nordului" }),
    makeLink(j4, j2, 1, 1, { name: "Strada Nordului", c1: c(-60, -80), c2: c(-10, -40) }),
    makeLink(j2, j5, 2, 2, { name: "Strada Teatrului" }),
    makeLink(j5, g4, 1, 1, { name: "Strada Teatrului" }),
    makeLink(g5, j6, 1, 1, { name: "Strada Morii" }),
    makeLink(j6, j4, 1, 1, { name: "Strada Morii", c1: c(-110, -80), c2: c(-70, -110) }),
    makeLink(j6, j1, 1, 1, { name: "Strada Croitorilor" }),
    makeLink(j4, j3, 2, 1, { name: "Strada Pieții", c1: c(40, -160), c2: c(120, -130), speed: 50 }),
    makeLink(j3, j8, 2, 0, { name: "Strada Dacia (one-way)", c1: c(210, -20), c2: c(215, 70) }),
    makeLink(j8, j5, 1, 1, { name: "Strada Parcului" }),
    makeLink(j8, g7, 1, 1, { name: "Strada Parcului" }),
    makeLink(j5, j9, 1, 1, { name: "Strada Școlii", c1: c(-30, 170), c2: c(-90, 195) }),
    makeLink(j9, j1, 1, 1, { name: "Strada Școlii" }),
    makeLink(j9, g6, 1, 1, { name: "Strada Școlii" }),
  ];
  for (const n of nodes) n.gateway = true; // only matters for dead ends

  const L = (name: string, from: NodeDef, to: NodeDef) => links.find(l => l.name.startsWith(name) && l.from === from.id && l.to === to.id)!;
  const stops = [
    { id: newId("s"), name: "Eroilor", link: L("Bulevardul", j1, j2).id, dir: 1 as const, pos: 0.55 },
    { id: newId("s"), name: "Piața Mare", link: L("Bulevardul", j2, j3).id, dir: 1 as const, pos: 0.5 },
    { id: newId("s"), name: "Dacia", link: L("Strada Dacia", j3, j8).id, dir: 1 as const, pos: 0.5 },
    { id: newId("s"), name: "Școlii", link: L("Strada Școlii", j5, j9).id, dir: 1 as const, pos: 0.55 },
  ];
  const lines = [{ id: newId("b"), name: "Line 1", color: "#D99800", stops: stops.map(s => s.id), buses: 3 }];
  return { version: 1, nodes, links, stops, lines };
}
