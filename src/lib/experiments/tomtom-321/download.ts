/**
 * The TomTom report as it is downloaded: everything the served page shows, but no ticket (as for the deep-learning
 * report, ticket #279). The builder (scripts/tomtom-321-report.ts) wraps the ticket's mentions in <!--ticket-->…<!--/ticket-->
 * and the page's own download link (pointless in the file itself) in <!--download-->…<!--/download-->; both go.
 * tomtom-321:check makes sure the built report has them and that nothing of the ticket is left.
 */

export const DOWNLOAD_NAME = "tomtom-traffic-and-one-way-streets-report.html";

const CUT = /<!--(ticket|download)-->[\s\S]*?<!--\/\1-->/g;

/** the report as downloaded; how many marked pieces it took out (0 means the report wasn't built with the markers) */
export function forDownload(html: string): { html: string; cut: number } {
  let cut = 0;
  const out = html.replace(CUT, () => { cut++; return ""; });
  return { html: out, cut };
}

/** what is left of the ticket in a page, for the check: the word, or its number */
export const ticketsIn = (html: string) => [...html.matchAll(/ticket|#321\b/gi)].map(m => m[0]);
