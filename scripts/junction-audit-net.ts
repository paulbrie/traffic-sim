/** Test network for the junction audit: every kind of junction control, signs, lane arrows, turning shares. */
import { compile } from "../src/engine/compile";
import { makeLink, makeNode } from "../src/engine/sample";
import type { Network } from "../src/engine/types";

/** a small district with every kind of junction control, signs, lane arrows and turning shares */
export function mixedDistrict(): Network {
  const N = (x: number, y: number, control: Parameters<typeof makeNode>[2] = "priority", gw = false) => makeNode(x, y, control, gw);
  const g = (x: number, y: number) => makeNode(x, y, "priority", true);
  const A = N(0, 0, "lights"), B = N(220, 0, "priority"), C = N(440, 0, "roundabout"), D = N(0, 200, "stop"), E = N(220, 200, "lights"), F = N(440, 200, "priority");
  const T = N(220, 380, "lights"); // T junction with a one-way arm
  const gws = [g(-200, 0), g(0, -200), g(220, -200), g(640, 0), g(440, -200), g(-200, 200), g(640, 200), g(0, 400), g(440, 400), g(220, 580)];
  const [w0, n0, n1, e0, n2, w1, e1, s0, s2, s1] = gws;
  const L = (a: ReturnType<typeof N>, b: ReturnType<typeof N>, f = 1, bk = 1, extra = {}) => makeLink(a, b, f, bk, extra);
  const links = [
    L(w0, A, 2, 2), L(n0, A, 1, 1), L(A, B, 2, 2), L(n1, B, 1, 1, { signF: "yield" }), L(B, C, 2, 2), L(n2, C, 1, 1), L(C, e0, 2, 2),
    L(w1, D, 1, 1), L(A, D, 1, 1), L(D, E, 1, 1), L(B, E, 2, 2), L(E, F, 1, 1), L(C, F, 1, 1, { signB: "stop" }), L(F, e1, 1, 1),
    L(D, s0, 1, 1), L(F, s2, 1, 1), L(E, T, 3, 0), L(T, s1, 2, 2), L(s2, T, 1, 0),
  ];
  const net: Network = { version: 1, nodes: [A, B, C, D, E, F, T, ...gws], links, stops: [], lines: [] };
  // turning shares on the three-lane one-way road into T, and lane arrows on the approach to E from B
  const c = compile(net);
  const eET = c.edges.find(e => e.link === links[16] && e.dir === 1)!;
  const moves = eET.to.moves.get(eET.idx)!;
  links[16].splitF = Object.fromEntries(moves.map(m => [m.out.link.id, m.turn === "R" ? 70 : 30]));
  links[10].turnsF = ["L", "S", "SR"].slice(0, links[10].lanesF) as Network["links"][number]["turnsF"];
  gws[0].inflow = 18; // a busy entrance
  return net;
}

