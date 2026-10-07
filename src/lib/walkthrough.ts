// A walkthrough the assistant can give with a change: steps shown one at a time in the chat, each taking the map
// to what it is about (and selecting it), and optionally changing the plan to how it is after that step.
// Imports nothing (the server reads it from the assistant's folder, the editor shows it).

export interface WalkStep {
  /** a few words, shown as the step's heading */
  title: string;
  /** what the step does and why (Markdown; ids become links) */
  text: string;
  /** ids (n_…, l_…, pk_…, x_…, J12) the map frames and selects */
  focus: string[];
  /** the whole plan as it is after this step (same format as network.json), or null: nothing changes */
  network: unknown;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** steps as written by the assistant, made safe to show (networks are checked where they are applied) */
export function readSteps(input: unknown): WalkStep[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 40).flatMap((s): WalkStep[] => {
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    const focus = (Array.isArray(o.focus) ? o.focus : typeof o.focus === "string" ? [o.focus] : []).filter((x): x is string => typeof x === "string").slice(0, 20);
    const text = str(o.text, 4000), title = str(o.title, 120);
    if (!text && !title) return [];
    return [{ title, text, focus, network: o.network && typeof o.network === "object" ? o.network : null }];
  });
}
