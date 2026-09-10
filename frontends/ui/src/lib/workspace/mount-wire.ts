/**
 * The wire shape of a mount answer, in one place for both adapters.
 *
 * `POST …/mounts` exists twice — the session route a person's scope tree calls
 * and the internal twin `open_project` calls — and MT-2's "one endpoint, one
 * permission check" is worth nothing if the two answer differently. The service
 * decides everything that matters; these two functions decide the two things
 * HTTP adds on top, so neither adapter has to remember them:
 *
 *   - **201 vs 200.** A new mount is created, a re-mount is not. Both carry the
 *     same body, because to the caller the outcome is identical: this
 *     conversation now reads that project.
 *   - **The cap's 409.** `cap` and `mounted` sit at the TOP LEVEL rather than
 *     under the envelope's `details`, because two very different clients read
 *     them — the UI to disable its add row with the reason visible, the Python
 *     tool to build the refusal string that names the cap and offers deep
 *     research (MT-9). One shape, so the tool and the UI cannot disagree about
 *     what the office is allowed to read.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type {
  MountResult,
  MountSetResult,
  WorkspaceMountCapError,
  WorkspaceMountExclusionError,
} from './mounts-service'

/**
 * What a mount request names: exactly one project, or exactly one Sammlung
 * (spec GR-2, MT-2).
 *
 * The shape is shared rather than written twice because both adapters accept
 * it, and the internal twin extends it with the envelope's identity fields. A
 * body naming both is a 400 rather than a precedence rule: two targets in one
 * call is a client bug, and inventing "the project wins" would make it a silent
 * one.
 */
export const MOUNT_TARGET_SHAPE = {
  projectId: z.string().uuid().optional(),
  projectSetId: z.string().uuid().optional(),
} as const

export function exactlyOneMountTarget(body: {
  projectId?: string
  projectSetId?: string
}): boolean {
  return (body.projectId ? 1 : 0) + (body.projectSetId ? 1 : 0) === 1
}

export const MOUNT_TARGET_MESSAGE = 'Name exactly one of projectId or projectSetId'

/** `201` for a new mount, `200` for the idempotent re-mount. */
export function mountResponse(result: MountResult): Response {
  return NextResponse.json(
    { mount: result.mount, grant: result.grant },
    { status: result.created ? 201 : 200 }
  )
}

/**
 * A Sammlung mounted as one unit (spec GR-2).
 *
 * A DIFFERENT shape from the single mount's, on purpose: `{ mount, grant }` is
 * what the UI and the Python tool already read, and folding a set into it —
 * one-element arrays, a nullable `set` — would make every existing reader parse
 * a case it never asks for. The request says which shape it wants by which
 * target it names.
 *
 * `201` when this call actually mounted something new, `200` when the
 * conversation already read every project in the set. Same rule as the single
 * mount, applied to the set: saying the same mount twice is not a second mount.
 */
export function mountSetResponse(result: MountSetResult): Response {
  return NextResponse.json(result, {
    status: result.mounts.some((entry) => entry.created) ? 201 : 200,
  })
}

/**
 * The exclusion refusal (spec AC-8), with the names both surfaces render.
 *
 * Top level for the same reason as the cap: the UI needs the list beside its
 * add row and the agent needs it inside a sentence, and a shape the two read
 * differently is a shape they can disagree about.
 */
export function mountExclusionResponse(error: WorkspaceMountExclusionError): Response {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      excluded: error.excluded,
    },
    { status: 409 }
  )
}

/** The cap refusal, with the two facts both surfaces render. */
export function mountCapResponse(error: WorkspaceMountCapError): Response {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      cap: error.cap,
      mounted: error.mounted,
      // Present only when a SET is what did not fit, so the sentence can name
      // the thing the person actually clicked.
      ...(error.set ? { set: error.set } : {}),
    },
    { status: 409 }
  )
}
