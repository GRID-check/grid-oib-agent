/**
 * The route handlers for a shelf's folders — written ONCE for a project's
 * Dateien (`/api/projects/[id]/folders*`) and the org-wide Archiv
 * (`/api/archiv/folders*`), because the two are the same routes (ADR-0078).
 *
 * What differs per shelf is passed in: the service call (which carries its own
 * authorization — `@/lib/projects/folder-service`, `@/lib/archiv/folder-service`)
 * and an optional feature gate (the Archiv is dark-launched behind
 * `organization-archiv`). What does not differ — the request schemas and their
 * limits, the mapping of a refused request to a 400, the response shapes — lives
 * here, so the browser can share one client and one row mapper.
 *
 * Handlers, not routes: each `route.ts` still calls `apiRoute` itself and
 * declares its own `authz`, which is what `authz-coverage.spec.ts` reads and
 * what a reviewer sees next to the verb.
 */

import { z } from 'zod'
import { parseJsonBody, type ApiContext } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DeleteFolderResult, FolderRow } from './shelf-folders'

/** A feature gate: the refusing response, or `null` when the surface is on. */
export type FolderRouteGate = (session: AuthorizedSession) => Response | null

type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string }

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
})

const updateFolderSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    // Explicit `null` moves the folder to the shelf root, which is why this is
    // `.nullable().optional()` and not merely optional: absent and null mean
    // different things here.
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, {
    message: 'Nothing to update.',
  })

const ensureFoldersSchema = z.object({
  /**
   * The level the paths are relative to — the folder the reader was standing in
   * when they dropped the tree. `null` is the shelf root.
   */
  parentId: z.string().uuid().nullable().optional(),
  /**
   * Distinct directory paths out of the dropped tree.
   *
   * Bounded here as well as in the service: this is the untrusted edge, and the
   * service's own ceiling exists for a caller that is not a route. 4096
   * characters per path is four times the `project_folders.path` column, which
   * is the real limit a segment walk runs into.
   */
  paths: z.array(z.string().min(1).max(4096)).max(300),
})

/** Run `handle` unless the shelf's feature gate refuses the caller. */
function gated<P>(gate: FolderRouteGate | undefined, handle: (ctx: ApiContext<P>) => Promise<unknown>) {
  return async (ctx: ApiContext<P>): Promise<unknown> => {
    const refusal = gate?.(ctx.session)
    return refusal ?? handle(ctx)
  }
}

/** A service answer that is either its value or a message the caller's request earned. */
function unwrap<T extends object>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new BadRequestError(outcome.error)
  return outcome
}

/** `GET …/folders` → `{ folders }`. */
export function listFoldersHandler<P>(
  list: (params: P, session: AuthorizedSession) => Promise<FolderRow[]>,
  gate?: FolderRouteGate,
) {
  return gated<P>(gate, async ({ session, params }) => ({ folders: await list(params, session) }))
}

/** `POST …/folders` `{ name, parentId? }` → `{ folder }`. */
export function createFolderHandler<P>(
  create: (
    params: P,
    session: AuthorizedSession,
    input: { name: string; parentId: string | null },
  ) => Promise<Outcome<{ folder: FolderRow }>>,
  gate?: FolderRouteGate,
) {
  return gated<P>(gate, async ({ session, params, request }) => {
    const { name, parentId } = await parseJsonBody(request, createFolderSchema)
    const { folder } = unwrap(await create(params, session, { name, parentId: parentId ?? null }))
    return { folder }
  })
}

/** `PATCH …/folders/[folderId]` `{ name?, parentId? }` → `{ folder }`. */
export function updateFolderHandler<P extends { folderId: string }>(
  update: (
    params: P,
    session: AuthorizedSession,
    patch: { name?: string; parentId?: string | null },
    request: Request,
  ) => Promise<Outcome<{ folder: FolderRow }>>,
  gate?: FolderRouteGate,
) {
  return gated<P>(gate, async ({ session, params, request }) => {
    const body = await parseJsonBody(request, updateFolderSchema)
    const { folder } = unwrap(
      await update(params, session, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      }, request),
    )
    return { folder }
  })
}

/**
 * `DELETE …/folders/[folderId]` → `{ documentsMoved, foldersMoved }`.
 *
 * The delete is the one worth reading before changing: `documents.folder_id` is
 * `ON DELETE CASCADE`, so the service re-files the folder's documents and its
 * child folders BEFORE removing the row. Deleting a label must not delete the
 * work that was filed under it.
 *
 * The Archiv's alone. A project folder's delete is the Papierkorb's
 * (`@/lib/projects/folder-bin`, ADR-0081), with its own route body and answer.
 */
export function deleteFolderHandler<P extends { folderId: string }>(
  remove: (params: P, session: AuthorizedSession, request: Request) => Promise<Outcome<{ result: DeleteFolderResult }>>,
  gate?: FolderRouteGate,
) {
  return gated<P>(gate, async ({ session, params, request }) => unwrap(await remove(params, session, request)).result)
}

/**
 * `POST …/folders/ensure` `{ parentId?, paths }` → `{ folders, folderIdByPath }`.
 *
 * Not the create endpoint with a loop in front of it: create makes ONE folder
 * under ONE parent and refuses a name a sibling already has — right for a person
 * typing into the New-folder popover, wrong for a folder upload, where "it
 * already exists" is the common case and the desired outcome. Driving a
 * 40-directory tree through it from the browser would also be 40 sequential
 * round trips before the first byte of the first file moved.
 */
export function ensureFoldersHandler<P>(
  ensure: (
    params: P,
    session: AuthorizedSession,
    input: { parentId: string | null; paths: string[] },
  ) => Promise<Outcome<{ folders: FolderRow[]; folderIdByPath: Record<string, string> }>>,
  gate?: FolderRouteGate,
) {
  return gated<P>(gate, async ({ session, params, request }) => {
    const { parentId, paths } = await parseJsonBody(request, ensureFoldersSchema)
    const { folders, folderIdByPath } = unwrap(
      await ensure(params, session, { parentId: parentId ?? null, paths }),
    )
    return { folders, folderIdByPath }
  })
}
