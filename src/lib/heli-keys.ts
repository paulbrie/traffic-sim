/**
 * The keys that fly the helicopter, set by each user (saved with their account). Keys are named as
 * `KeyboardEvent.key` lower-cased, so they follow the keyboard's layout (on a French keyboard, Z is Z).
 * Each action has up to two keys.
 */
export const HELI_ACTIONS = [
  { id: "forward", label: "Forward" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "climb", label: "Climb" },
  { id: "descend", label: "Descend" },
  { id: "faster", label: "Faster (hold)" },
  { id: "view", label: "Cockpit / outside" },
] as const;
export type HeliAction = (typeof HELI_ACTIONS)[number]["id"];
export type HeliKeys = Record<HeliAction, string[]>;

export const DEFAULT_HELI_KEYS: HeliKeys = {
  forward: ["z", "arrowup"], back: ["s", "arrowdown"], left: ["q", "arrowleft"], right: ["d", "arrowright"],
  climb: ["e", "pageup"], descend: ["a", "pagedown"], faster: ["shift"], view: ["c"],
};

/** keys that can't be used: they belong to the browser or to the rest of the app */
const RESERVED = new Set(["escape", "tab", "meta", "control", "alt", "contextmenu", "f5", "f11", "f12", "dead", "unidentified", "process"]);
export const keyAllowed = (k: string) => !!k && !RESERVED.has(k);

/** keep only known actions, known-good keys, at most two per action, no key twice */
export function sanitizeHeliKeys(input: unknown): HeliKeys {
  const out = { ...DEFAULT_HELI_KEYS };
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>, used = new Set<string>();
  for (const a of HELI_ACTIONS) {
    const v = src[a.id];
    if (!Array.isArray(v)) continue;
    const keys = v.filter((k): k is string => typeof k === "string" && k.length <= 20).map(k => k.toLowerCase()).filter(k => keyAllowed(k) && !used.has(k)).slice(0, 2);
    keys.forEach(k => used.add(k));
    out[a.id] = keys;
  }
  return out;
}

/** which action a key does (null: none) */
export function actionOf(keys: HeliKeys, key: string): HeliAction | null {
  for (const a of HELI_ACTIONS) if (keys[a.id].includes(key)) return a.id;
  return null;
}

const NAMES: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", " ": "Space", pageup: "PgUp", pagedown: "PgDn",
  shift: "Shift", enter: "Enter", backspace: "⌫", delete: "Del", home: "Home", end: "End", insert: "Ins", capslock: "Caps",
};
/** how a key is shown */
export const keyLabel = (k: string) => NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
