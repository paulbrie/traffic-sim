import "server-only";
import { join } from "path";

export { sizeOf } from "../dl-city-277/files";

/**
 * The TomTom experiment's report, served by the app from the checkout: docs/experiments/tomtom-321/index.html
 * (built by scripts/tomtom-321-report.ts from the runs recorded beside it).
 */
export const REPORT_FILE = join(process.cwd(), "docs/experiments/tomtom-321/index.html");

/** the plan the experiment ran on */
export const PLAN_ID = "b87c01a7-40ea-4aa3-a72a-7c917a58091b";
