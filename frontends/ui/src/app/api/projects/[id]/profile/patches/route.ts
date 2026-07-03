import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { applyProjectProfilePatch } from '@/lib/project-profile/prompt-view'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { buildProfileUpdate, toProfileResponse } from '../route'

const isAuthzError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message === 'not found' ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}

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
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!current) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    let profile
    try {
      profile = applyProjectProfilePatch(current.profile, parsed.data.patch)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid project profile patch.' }, { status: 400 })
    }

    const values = buildProfileUpdate(profile, current.profileVersion)
    const [project] = await db.update(projects).set(values).where(eq(projects.id, id)).returning()

    return NextResponse.json(toProfileResponse(project))
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Profile Patches API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
