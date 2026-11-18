/** One simulation worker for scripts/dl-city-run.ts (ticket #277): runs the designs it is sent, one at a time, and answers with their metrics. */
import { generateCity } from "../src/lib/experiments/dl-city/city";
import { parseKey } from "../src/lib/experiments/dl-city/design";
import { runDesign } from "../src/lib/experiments/dl-city/evaluate";

const city = generateCity(Number(process.env.CITY_SEED ?? 1));
process.on("message", (msg: { id: number; key: string; seed: number; warmupMin: number; measureMin: number }) => {
  try {
    const m = runDesign(city, parseKey(msg.key), { seed: msg.seed, warmupMin: msg.warmupMin, measureMin: msg.measureMin });
    process.send!({ id: msg.id, m });
  } catch (e) {
    process.send!({ id: msg.id, error: String((e as Error)?.stack ?? e) });
  }
});
