/**
 * The page as an agent reads it (the bridge's `snapshot`) and finds things in it (`click`, `type`), as Playwright's
 * getByRole does: each element's role (its ARIA role, or the one its tag implies) and accessible name. The bridge's own
 * UI (`[data-bridge-ui]`) is left out of both; a password field's value is never read.
 */

const INPUT_ROLE: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
  search: "searchbox", email: "textbox", text: "textbox", url: "textbox", tel: "textbox", password: "textbox",
};
const TAG_ROLE: Record<string, string> = {
  button: "button", select: "combobox", textarea: "textbox", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  nav: "navigation", main: "main", aside: "complementary", form: "form", table: "table", tr: "row", td: "cell", th: "columnheader",
  ul: "list", ol: "list", li: "listitem", dialog: "dialog", option: "option", progress: "progressbar", summary: "button",
};
/** roles worth a line of their own */
const SHOWN = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "slider", "spinbutton", "combobox", "listbox", "option", "menu", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "tablist", "tabpanel", "tree", "treeitem", "heading", "region", "navigation", "main", "complementary",
  "banner", "dialog", "alertdialog", "alert", "status", "table", "row", "cell", "columnheader", "img", "progressbar", "toolbar", "group", "radiogroup", "form",
]);
const MAX_LINES = 1200, TABLE_ROWS = 6;

export const isBridgeUi = (el: Element) => !!el.closest("[data-bridge-ui]");

export function roleOf(el: Element): string | null {
  const r = el.getAttribute("role");
  if (r) return r.split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "input") return INPUT_ROLE[(el as HTMLInputElement).type] ?? "textbox";
  if (tag === "img") return el.getAttribute("alt") ? "img" : null;
  if (tag === "section") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
  if (tag === "header") return el.closest("main, article, section, aside, nav") ? null : "banner";
  return TAG_ROLE[tag] ?? null;
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** an element's own text, without that of the bridge's UI */
const textOf = (el: Element) => squash(el.textContent);

export function nameOf(el: Element): string {
  const al = el.getAttribute("aria-label");
  if (al) return squash(al);
  const by = el.getAttribute("aria-labelledby");
  if (by) { const t = by.split(/\s+/).map(id => textOf(document.getElementById(id) ?? document.createElement("x"))).join(" "); if (squash(t)) return squash(t); }
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const id = el.getAttribute("id"), lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest("label");
    if (lab) return textOf(lab);
    return squash(el.getAttribute("placeholder") || el.getAttribute("title"));
  }
  if (tag === "img") return squash(el.getAttribute("alt"));
  const role = roleOf(el);
  if (role && ["button", "link", "heading", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "cell", "columnheader", "switch", "checkbox", "radio"].includes(role)) {
    const t = textOf(el);
    if (t) return t.slice(0, 120);
  }
  return squash(el.getAttribute("title"));
}

const hidden = (el: Element) => {
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return true;
  const ce = el as HTMLElement & { checkVisibility?: () => boolean };
  return ce.checkVisibility ? !ce.checkVisibility() : getComputedStyle(el).display === "none";
};

function valueOf(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return el.value ? "••••" : "";
    if (el.type === "checkbox" || el.type === "radio" || el.type === "button" || el.type === "submit") return null;
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value.slice(0, 200);
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? el.value;
  const now = el.getAttribute("aria-valuenow");
  return now ?? null;
}

function statesOf(el: Element): string[] {
  const out: string[] = [];
  const a = (k: string) => el.getAttribute(k);
  if ((el as HTMLButtonElement).disabled || a("aria-disabled") === "true") out.push("disabled");
  if ((el as HTMLInputElement).checked || a("aria-checked") === "true" || a("data-state") === "checked") out.push("checked");
  if (a("aria-selected") === "true") out.push("selected");
  if (a("aria-expanded") === "true") out.push("expanded"); else if (a("aria-expanded") === "false") out.push("collapsed");
  if (a("aria-pressed") === "true" || (a("data-state") === "on" && roleOf(el) !== "switch")) out.push("pressed");
  if (document.activeElement === el) out.push("focused");
  const level = /^h([1-6])$/.exec(el.tagName.toLowerCase());
  if (level) out.push(`level ${level[1]}`);
  return out;
}

/** the accessibility tree under `root`, one line per node: role "name" [value] {states}, indented by depth */
export function snapshot(root: Element): string {
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    if (lines.length >= MAX_LINES || isBridgeUi(el) || hidden(el)) return;
    const role = roleOf(el);
    let d = depth;
    if (role && SHOWN.has(role)) {
      const name = nameOf(el), value = valueOf(el), st = statesOf(el);
      lines.push(`${"  ".repeat(depth)}${role}${name ? ` "${name}"` : ""}${value !== null && value !== "" ? ` [${value}]` : ""}${st.length ? ` {${st.join(", ")}}` : ""}`);
      d = depth + 1;
      // (named controls: what is inside them is in their name already)
      if (["button", "link", "option", "menuitem", "tab", "heading", "cell", "columnheader", "treeitem", "switch", "checkbox", "radio"].includes(role)) return;
      if (role === "table") {
        // (a table: its first rows)
        const rows = [...el.querySelectorAll("tr")].slice(0, TABLE_ROWS);
        for (const r of rows) lines.push(`${"  ".repeat(d)}row "${[...r.children].map(c => textOf(c)).join(" | ").slice(0, 200)}"`);
        const more = el.querySelectorAll("tr").length - rows.length;
        if (more > 0) lines.push(`${"  ".repeat(d)}… ${more} more rows`);
        return;
      }
    } else if (!role && el.children.length === 0) {
      // (short text on its own: a figure and what it is, in the panels)
      const t = textOf(el);
      if (t && t.length <= 80 && !["script", "style", "svg"].includes(el.tagName.toLowerCase())) lines.push(`${"  ".repeat(depth)}text "${t}"`);
      return;
    }
    for (const c of el.children) walk(c, d);
  };
  walk(root, 0);
  if (lines.length >= MAX_LINES) lines.push(`… cut at ${MAX_LINES} lines (ask for a part: snapshot { root: "<selector>" })`);
  return lines.join("\n");
}

/** what a command points at: by role and name (as getByRole: name a case-insensitive part unless exact), a CSS selector, or text */
export interface Target { role?: string; name?: string; exact?: boolean; nth?: number; selector?: string; text?: string }

export function find(t: Target): Element {
  let found: Element[];
  if (t.selector) found = [...document.querySelectorAll(t.selector)];
  else if (t.role) {
    const want = t.name?.toLowerCase();
    found = [...document.querySelectorAll("*")].filter(el => roleOf(el) === t.role && (!want || (t.exact ? nameOf(el).toLowerCase() === want : nameOf(el).toLowerCase().includes(want))));
  } else if (t.text) {
    const want = t.text.toLowerCase();
    // (the innermost elements whose text has it)
    found = [...document.querySelectorAll("body *")].filter(el => textOf(el).toLowerCase().includes(want) && ![...el.children].some(c => textOf(c).toLowerCase().includes(want)));
  } else throw new Error("say what to act on: role (and name), selector or text");
  found = found.filter(el => !isBridgeUi(el) && !hidden(el));
  const el = found[t.nth ?? 0];
  if (!el) throw new Error(`nothing found for ${JSON.stringify(t)}${found.length ? ` (only ${found.length})` : ""}`);
  return el;
}

/** a short description of an element, as `role "name"` */
export const describe = (el: Element) => { const r = roleOf(el) ?? el.tagName.toLowerCase(), n = nameOf(el); return n ? `${r} "${n}"` : r; };

/** the roles and names of what lies under a rectangle of the page (client px), for an annotation */
export function under(rect: { x: number; y: number; w: number; h: number }): string[] {
  const out = new Set<string>();
  for (const el of document.querySelectorAll("body *")) {
    if (isBridgeUi(el)) continue;
    const role = roleOf(el);
    if (!role || !SHOWN.has(role) || hidden(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.right < rect.x || b.left > rect.x + rect.w || b.bottom < rect.y || b.top > rect.y + rect.h || b.width === 0) continue;
    out.add(describe(el));
    if (out.size >= 40) break;
  }
  return [...out];
}
