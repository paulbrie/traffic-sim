// History's file actions for a V2 plan ("Restore from file", "Apply changes from file"): the decisions, apart
// from the database and the session so they can be checked (scripts/restore-file-check.ts). The server action
// in actions.ts proves the access and passes the data layer in.
import { sanitizeSketch, type Sketch } from "@/lib/lane-sketch";
import { fileResult, pickPatch, type FileMode } from "@/lib/sketch-diff";
import type { SaveResult } from "./data/plans";

export const RESTORE_NOTE_MAX = 500;

/** `file`: what the client read from the file for `mode` (`payloadOf`) */
export type RestoreFileInput = { mode: FileMode; file: unknown; revision: number; note?: unknown; fileName?: unknown };
export type RestoreFileResult = { ok: true; revision: number } | { ok: false; error: string; revision?: number };

export interface RestoreFileDeps {
  /** the user may save this plan (the same rule as saving it) */
  canEdit: boolean;
  /** the plan's current state, or null if it is gone */
  current: () => Promise<{ engine: string; network: unknown; settings: unknown; underlay: unknown; sketch: unknown } | null>;
  /** the normal save path, recorded as its own "restore" version with `note` */
  save: (input: { network: unknown; settings: unknown; underlay: unknown; sketch: Sketch; revision: number; restore: { note: string } }) => Promise<SaveResult>;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** the note History shows for it: what was done from which file, then the user's own */
export function restoreNote(mode: FileMode, fileName: unknown, note: unknown): string {
  const file = text(fileName, 120), own = text(note, RESTORE_NOTE_MAX);
  return `${mode === "apply" ? "Applied changes from" : "Restored from"} ${file ? `the file ${file}` : "a file"}${own ? `: ${own}` : ""}`;
}

export async function restoreFromFile(input: RestoreFileInput, deps: RestoreFileDeps): Promise<RestoreFileResult> {
  if (!deps.canEdit) return { ok: false, error: "You can't change this plan." };
  if (input.mode !== "restore" && input.mode !== "apply") return { ok: false, error: "Unknown action." };
  if (!Number.isInteger(input.revision) || input.revision < 0) return { ok: false, error: "Reload the plan and try again." };
  // (checked before reading the plan; checked again on the stored sketch below)
  if (input.mode === "apply" ? !pickPatch(input.file) : !fileResult(input.file, "restore", null).ok) return { ok: false, error: "That file isn't a usable V2 sketch." };
  const cur = await deps.current();
  if (!cur) return { ok: false, error: "Plan not found." };
  if (cur.engine !== "v2") return { ok: false, error: "Only V2 plans can take a sketch file." };
  const r = fileResult(input.file, input.mode, sanitizeSketch(cur.sketch));
  if (!r.ok) return { ok: false, error: r.error };
  const s = await deps.save({ network: cur.network, settings: cur.settings, underlay: cur.underlay, sketch: r.sketch, revision: input.revision, restore: { note: restoreNote(input.mode, input.fileName, input.note) } });
  if (s.ok) return { ok: true, revision: s.revision };
  if (s.reason === "conflict") return { ok: false, error: "The plan was saved by someone else in the meantime. Look at the summary again and retry.", revision: s.revision };
  return { ok: false, error: s.reason === "forbidden" ? "You can't change this plan." : "Plan not found." };
}
