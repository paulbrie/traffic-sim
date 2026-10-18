/**
 * The plan editor's keys wherever the focus is (T157b): a key pressed with the focus outside the editor (on the
 * header's switches, a menu's button after it closed, the Console's filter, a panel's select, or nowhere) still goes
 * to the editor, unless it belongs where the focus is: typing in a text field, an open menu, list or dialog, and
 * the keys a focused control uses itself (Enter and Space press a button, arrows move in a group, a select's
 * letters pick an option). Tab always moves the focus. Framework-free, so it can be checked.
 */

/** what is known of the element the key went to */
export type KeyTarget = {
  tag: string;
  /** an <input>'s type */
  type?: string;
  role?: string | null;
  editable?: boolean;
};

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week", ""]);
const CONTROL_ROLES = new Set(["button", "radio", "tab", "switch", "checkbox", "option", "menuitem", "menuitemradio", "menuitemcheckbox", "slider", "spinbutton", "link", "treeitem"]);
const OWN_KEYS = new Set(["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** a key pressed on `t` (outside the editor) should go to the editor; `open`: a menu, list or dialog is open */
export function keyForEditor(key: string, mod: boolean, t: KeyTarget | null, open: boolean): boolean {
  if (key === "Tab" || open) return false;
  if (!t) return true;
  const tag = t.tag.toLowerCase();
  if (t.editable || tag === "textarea" || t.role === "textbox" || t.role === "searchbox" || t.role === "combobox" && tag === "input") return false;
  if (tag === "input") {
    const type = (t.type ?? "").toLowerCase();
    if (TEXT_INPUTS.has(type)) return false;
    // (a checkbox, a radio, a range: its own keys stay)
    return !OWN_KEYS.has(key);
  }
  // (a native select picks options by letter: only Escape and the shortcuts with ⌘ / Ctrl)
  if (tag === "select") return key === "Escape" || mod;
  if (tag === "button" || tag === "a" || tag === "summary" || (t.role && CONTROL_ROLES.has(t.role)) || t.role === "combobox") return !OWN_KEYS.has(key);
  return true;
}

/** the element a key went to, as keyForEditor reads it */
export function keyTargetOf(el: Element | null): KeyTarget | null {
  if (!el || el === document.body || el === document.documentElement) return null;
  return { tag: el.tagName, type: el instanceof HTMLInputElement ? el.type : undefined, role: el.getAttribute("role"), editable: el instanceof HTMLElement && el.isContentEditable };
}

/** a menu, list box or dialog open in the page (they have the keys while open) */
export const somethingOpen = () => !!document.querySelector('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]');
