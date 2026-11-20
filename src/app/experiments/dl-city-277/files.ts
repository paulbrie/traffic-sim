import "server-only";
import { stat } from "fs/promises";
import { join } from "path";

/**
 * The deep-learning city experiment's outputs (ticket #277), served by the app from the checkout:
 * docs/experiments/dl-city-277/index.html (the report, built by scripts/dl-city-html.ts) and
 * video.webm (the explainer, made by scripts/dl-city-video.ts).
 */
const DIR = join(process.cwd(), "docs/experiments/dl-city-277");
export const REPORT_FILE = join(DIR, "index.html");
export const VIDEO_FILE = join(DIR, "video.webm");

/** the file's size, or null when it isn't there (not built yet, or not shipped with this deployment) */
export async function sizeOf(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** the experiment's city in the database (scripts/dl-city-save.ts) */
export const CITY_ID = "a2c30496-c428-47cb-916c-4aabd6bdd849";
