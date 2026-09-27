<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project notes

- Engine code in `src/engine` must stay framework-free (runs in Node for `npm run engine:check`).
- Client state lives in subjecto stores in `src/state/store.ts`; mutate `ui` through its proxy (`ui.getValue().x = …`), replace the network through `commit()` so undo and autosave work.
- Pages that read the database call `connection()` (see `src/server/queries.ts`) so they render per request.
- shadcn components in `src/components/ui` were written by hand in the new-york style; `npx shadcn add <name>` works for more.
- Auth: pages call `requireUser()` / `requireAdmin()`, server actions and route handlers call `assertUser()` / `getCurrentUser()` (`src/server/auth.ts`). `src/proxy.ts` only does an optimistic cookie check.
