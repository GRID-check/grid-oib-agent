import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isAuthzError } from '@/lib/auth-utils'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { applyProjectProfilePatch, invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { normalizeProfilePatchOperations, pruneResolvedUnknowns } from '@/lib/project-profile/patch-engine'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { buildProfileUpdate, toProfileResponse } from '../route'

const patchProfileSchema = z.object({
  patch: z.array(ProjectProfilePatchOperationSchema),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:edit')

    const body = await request.json().catch(() => null)
    const parsed = patchProfileSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid project profile patch.' }, { status: 400 })
    }

    const db = getDb()
    const [current] = await db
      .select({
        profile: projects.profile,
        profileVersion: projects.profileVersion,
        profileDisplay: projects.profileDisplay,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!current) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    let profile
    try {
      // Agent-proposed patches carry bare values; wrap them with provenance
      // (accepting the card is the user confirmation), then retire any
      // unknowns the patch just answered.
      const normalized = normalizeProfilePatchOperations(parsed.data.patch)
      profile = pruneResolvedUnknowns(applyProjectProfilePatch(current.profile, normalized))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid project profile patch.' }, { status: 400 })
    }

    const currentVersion = current.profileVersion
    const values = buildProfileUpdate(profile, currentVersion, current.profileDisplay?.summary ?? '')
    const [project] = await db
      .update(projects)
      .set(values)
      .where(and(eq(projects.id, id), eq(projects.profileVersion, currentVersion)))
      .returning()

    if (!project) {
      return NextResponse.json({ error: 'Conflict: profile was modified by another request' }, { status: 409 })
    }

    invalidateProjectPromptViewCache(id)
    return NextResponse.json(toProfileResponse(project))
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Profile Patches API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
