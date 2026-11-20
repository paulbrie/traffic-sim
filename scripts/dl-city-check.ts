/**
 * dl-city:check (ticket #277): the deep-learning city experiment's pieces do what the experiment counts on.
 *  - the random city: the same seed, the same city; Bistrița-like (junctions, ways in and out, a dense centre, a main road
 *    from the south-west to the north-east), its V2 sketch made by the app's converter, with no way in or out left over;
 *  - designs: whatever the searches make of them (random, mutated, crossed), two streets with four lanes and no more, every
 *    other street at most one lane each way, every place still reached from every other;
 *  - the neural networks learn (a target they can, on designs they never saw);
 *  - a run is repeatable: the same design and seed, the same results;
 *  - the analysis of a few runs: the status quo scores 1, curves start from it.
 * Exits 1 on any failure.
 */
import { generateCity, rng, STREETS } from "../src/lib/experiments/dl-city/city";
import { baseline, connected, crossover, designKey, designNetwork, designSketch, encode, features, mutate, randomDesign, type Design } from "../src/lib/experiments/dl-city/design";
import { runDesign, score } from "../src/lib/experiments/dl-city/evaluate";
import { scoreOf, targets } from "../src/lib/experiments/dl-city/search";
import { Ensemble, r2 } from "../src/lib/experiments/dl-city/mlp";
import { analyse } from "../src/lib/experiments/dl-city/analysis";
import { forDownload, ticketsIn } from "../src/lib/experiments/dl-city/download";
import { demandWays } from "../src/lib/lane-sketch";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const city = generateCity(1), again = generateCity(1);
check(JSON.stringify(city) === JSON.stringify(again), "the same seed makes the same city");
check(JSON.stringify(generateCity(2).nodes) !== JSON.stringify(city.nodes), "another seed, another city");
const base = baseline(city), b = designSketch(city, base);
const ways = demandWays(b.sketch), j = b.sketch.junctions.length;
check(!b.error, `the status quo converts to a V2 sketch (${b.sketch.lanes.length} lanes, ${b.sketch.connectors.length} connectors, ${j} junctions, ${b.sketch.roads.length} roads)`);
check(j >= 130 && j <= 320, `Bistrița-like junction count (${j}; Bistrița Auto Search: 266)`);
check(ways.entries.length >= 40 && ways.entries.length <= 120, `ways in all round and inside the town (${ways.entries.length}; Bistrița Auto Search: 67)`);
const sw = city.nodes[city.sw], ne = city.nodes[city.ne];
check(sw.x < -600 && sw.y > 600 && ne.x > 600 && ne.y < -600, `the main road runs from the south-west (${sw.x}, ${sw.y}) to the north-east (${ne.x}, ${ne.y})`);
check(b.centreRoads.length >= 30, `the centre has its streets (${b.centreRoads.length} roads inside the ring)`);
check(b.corridor.swIn.length > 0 && b.corridor.neOut.length > 0 && b.corridor.neIn.length > 0 && b.corridor.swOut.length > 0, "the corridor's ways in and out at both ends");
const stray = b.sketch.lanes.filter(l => ways.entries.some(w => w.lanes.includes(l.id)) && l.inRate === undefined);
check(stray.length === 0, "every way in has its rate set (none left to the sketch's default)");
const inTotal = b.sketch.lanes.reduce((a, l) => a + (l.inRate ?? 0), 0);
check(inTotal > 2000 && inTotal < 6000, `demand of a Bistrița-like peak (${inTotal} veh/h in at the ways in, plus ${2 * city.corridor} on the corridor)`);

// designs: the ticket's rule, and connected, whatever the searches do to them
const R = rng(9);
const four = new Set(STREETS.map((_, k) => k));
const rule = (d: Design) => {
  const net = designNetwork(city, d), fourLane = new Set<string>(d.four.map(k => STREETS[k].name));
  const wide = new Set(net.links.filter(l => Math.max(l.lanesF, l.lanesB) > 1).map(l => l.name));
  return d.four[0] !== d.four[1] && four.has(d.four[0]) && four.has(d.four[1]) && [...wide].every(n => fourLane.has(n)) && net.links.every(l => Math.max(l.lanesF, l.lanesB) <= 2);
};
let ok = 0, conn = 0, n = 0;
const pop: Design[] = [base];
for (let k = 0; k < 60; k++) {
  const a = pop[Math.floor(R() * pop.length)], c = k % 3 === 0 ? randomDesign(city, R, 0.3, 0.4) : k % 3 === 1 ? mutate(city, a, R, 2) : crossover(city, a, pop[Math.floor(R() * pop.length)], R);
  pop.push(c); n++;
  if (rule(c)) ok++;
  if (connected(city, c)) conn++;
}
check(ok === n, `two four-lane streets at most, the others one lane each way at most (${ok} of ${n} designs)`);
check(conn === n, `every place reached from every other, closures and one-ways repaired (${conn} of ${n})`);
const bold = randomDesign(city, R, 0.3, 0.4);
check(!designSketch(city, bold).error, "a bold random design converts too");
check(encode(city, base).length === 7 + 3 * base.centre.length + 3 * base.control.length, `one-hot genes (${encode(city, base).length})`);
check(features(city, base).length === encode(city, base).length + 6 && features(city, base).slice(-6).every(v => v === 0), "the networks' inputs: the genes and six sums over them (none for the status quo)");

// the networks learn what can be learnt
const D = Array.from({ length: 260 }, () => randomDesign(city, R, R() * 0.3, R() * 0.4)), X = D.map(d => encode(city, d));
// (a few genes matter, as in a town: which streets get four lanes, a handful of links, a junction or two)
const W = X[0].map((_, i) => (i < 7 || R() < 0.08 ? R() - 0.5 : 0)), f = (x: number[]) => x.reduce((a, v, i) => a + v * W[i], 0);
// (as the experiment's: five networks of 64 and 32 units, on 200 designs)
const ens = new Ensemble(5, [64, 32], 5).fit(X.slice(0, 200), X.slice(0, 200).map(x => [f(x)]));
const fit = r2(X.slice(200).map(f), X.slice(200).map(x => ens.predict(x).mean[0]));
check(fit > 0.7, `the networks learn a sparse linear target on designs they never saw (R² ${fit.toFixed(3)})`);

// a run is repeatable (short)
const o = { seed: 3, warmupMin: 0.5, measureMin: 1.5 };
const m1 = runDesign(city, base, o), m2 = runDesign(city, base, o);
check(JSON.stringify({ ...m1, ms: 0 }) === JSON.stringify({ ...m2, ms: 0 }), `the same design and seed, the same results (${m1.trips.toFixed(0)} trips/h, centre ${m1.centreVehKm.toFixed(0)} veh-km/h)`);
check(m1.trips > 0 && m1.centreVehKm > 0, "cars come in, drive the centre, and leave");

// the analysis (made-up results: a run this short has no corridor trip through yet)
const fake = { corridorTrips: 1200, corridorTime: 330, corridorWaiting: 0, centreVehKm: 1500, trips: 4600, tripTime: 190, vehKm: 6500, stuck: 40, deadlocks: 0, collisions: 3, ms: 1 };
const runs = [1, 2, 3, 4, 5].map(seed => ({ key: designKey(base), seed, method: "baseline", round: 0, m: { ...fake, corridorTime: 300 + 10 * seed } }));
const other = randomDesign(city, R);
runs.push(...[1, 2].map(seed => ({ key: designKey(other), seed, method: "ga", round: 1, m: { ...fake, centreVehKm: 1200 } })));
const a = analyse(runs);
const bd = a.designs.find(d => d.method === "baseline")!;
check(Math.abs(bd.score - 1) < 1e-9 && Math.abs(bd.score5! - 1) < 1e-9, "the status quo scores 1");
check(a.curves.ga.length === 2 && a.curves.ga[0].best === 1 && a.curves.ga[1].best < 1, "the search's curve starts from the status quo and improves");

// the score worked out from the networks' targets is the score
const mm = { ...fake, corridorTime: 410, centreVehKm: 900, trips: 4300, tripTime: 230, stuck: 90 };
check(Math.abs(scoreOf(targets(mm, fake)) - score(mm, fake)) < 1e-9, `the score from the networks' targets is the score (${score(mm, fake).toFixed(4)})`);

// the report as downloaded (ticket #279): every edit still finds its text, and no ticket is left
const REPORT = join(__dirname, "../docs/experiments/dl-city-277/index.html");
if (existsSync(REPORT)) {
  const page = readFileSync(REPORT, "utf8"), dl = forDownload(page);
  check(dl.missed.length === 0, `the download's edits all find their text in the report${dl.missed.length ? ` (not: ${dl.missed.join(" | ")})` : ""}`);
  check(ticketsIn(dl.html).length === 0, `no ticket left in the download${ticketsIn(dl.html).length ? ` (${ticketsIn(dl.html).join(", ")})` : ""}, only in the page (${ticketsIn(page).length})`);
  check(page.length - dl.html.length < 2000, `the download is the whole report otherwise (${page.length - dl.html.length} bytes shorter)`);
}

if (fails) { console.error(`dl-city:check: ${fails} failed`); process.exit(1); }
console.log("dl-city:check: all passed");
