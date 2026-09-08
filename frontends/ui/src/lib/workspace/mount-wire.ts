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
import type { WorkspaceMountCapError, MountResult } from './mounts-service'

/** `201` for a new mount, `200` for the idempotent re-mount. */
export function mountResponse(result: MountResult): Response {
  return NextResponse.json(
    { mount: result.mount, grant: result.grant },
    { status: result.created ? 201 : 200 }
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
    },
    { status: 409 }
  )
}
