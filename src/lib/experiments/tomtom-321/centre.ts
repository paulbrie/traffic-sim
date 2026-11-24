/**
 * Bistrița's centre on the plan (ticket #321): inside Bulevardul Republicii (north-west), Bulevardul General Grigore Bălan and
 * Strada Ecaterina Teodoroiu (north-east and east), Strada Parcului and Strada Dogarilor (south), Strada Alexandru Odobescu
 * (south-west): Piața Centrală, Piața Mică, Piața Unirii, Strada Dornei, Strada Nicolae Titulescu, … (the plan's metres,
 * x east, y south, from its geo point). Framework-free.
 */
import { laneLength, pointAt, type Pt, type Sketch } from "../../lane-sketch";

export const CENTRE: Pt[] = [
  { x: -440, y: 481 }, { x: 247.5, y: -220 }, { x: 426.25, y: -110 }, { x: 440, y: 247.5 }, { x: 357.5, y: 550 }, { x: 68.75, y: 673.75 }, { x: -247.5, y: 646.25 },
];

export function inCentre(p: Pt): boolean {
  let c = false;
  for (let i = 0, j = CENTRE.length - 1; i < CENTRE.length; j = i++) {
    const a = CENTRE[i], b = CENTRE[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** the roads in the centre (all their lanes' middles inside) */
export function centreRoads(sk: Sketch): string[] {
  const lanes = new Map(sk.lanes.map(l => [l.id, l]));
  return sk.roads.filter(r => r.lanes.length && r.lanes.every(id => { const l = lanes.get(id); return l && inCentre(pointAt(l.shape, laneLength(l.shape) / 2).p); })).map(r => r.id);
}
