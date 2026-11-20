/**
 * The report as it is downloaded (ticket #279): everything the page shows, but no ticket. The served page keeps them
 * (the team's); the copy handed out loses them from its title, the line over the heading, the method's "ticket's
 * rule", a reference to #274, the centre zone's note and a help text in the bundled simulator, and loses the download
 * link (pointless in the file itself). Plain text replacements on the built index.html; dl-city:check makes sure each
 * still finds its text and that no ticket is left.
 */

export const DOWNLOAD_NAME = "deep-learning-city-report.html";

/** [what it finds, what it puts there]: each must be in the built report exactly once */
export const DOWNLOAD_EDITS: readonly (readonly [string, string])[] = [
  ["<title>Ticket #277 · ", "<title>"],
  [
    '<p class="meta">trafficsim · ticket #277 · built <span data-v="built"></span> on commit <span data-v="commit"></span> · ',
    '<p class="meta">trafficsim · built <span data-v="built"></span> · ',
  ],
  ["This is the ticket's rule.", "This is the brief's rule."],
  ["Later engine changes, such as #274's on two-lane roundabouts,", "Later engine changes, such as those on two-lane roundabouts,"],
  ['note:"Ticket #277: the traffic inside it', 'note:"The traffic inside it'],
  // (the bundled simulator's help on slopes)
  ["set by hand; ticket #130).", "set by hand)."],
];

/** the download link's paragraph, from its start to its end */
const LINK = /\n {2}<p><a class="download"[^\n]*<\/p>/;

/** the report as downloaded; the edits that didn't find their text (none, unless the report changed) */
export function forDownload(html: string): { html: string; missed: string[] } {
  const missed: string[] = [];
  let out = html;
  for (const [find, put] of DOWNLOAD_EDITS) {
    const at = out.indexOf(find);
    if (at < 0 || out.indexOf(find, at + 1) >= 0) missed.push(find);
    else out = out.slice(0, at) + put + out.slice(at + find.length);
  }
  if (LINK.test(out)) out = out.replace(LINK, "");
  else missed.push("the download link");
  return { html: out, missed };
}

/** what is left of tickets in a page, for the check: the word, or a ticket's number ("#274's", "#277") */
export const ticketsIn = (html: string) => [...html.matchAll(/ticket|#2\d\d(?=['\s:.,)])/gi)].map(m => m[0]);
