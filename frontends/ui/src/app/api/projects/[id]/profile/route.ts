import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isAuthzError } from '@/lib/auth-utils'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { buildProjectProfileDisplay, buildProjectPromptView, invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { ProjectProfileSchema } from '@/lib/project-profile/types'
import type { ProjectProfile, ProjectProfileDisplay } from '@/lib/project-profile/types'

export type StoredProfileResponse = {
  profile: ProjectProfile
  profileVersion: number
  profilePromptView: string | null
  profileDisplay: ProjectProfileDisplay | null
  profileUpdatedAt: Date | null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:view')

    const db = getDb()
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)

    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(toProfileResponse(project))
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Profile API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:edit')

    const body = await request.json().catch(() => null)
    const parsed = ProjectProfileSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid project profile.' }, { status: 400 })
    }

    const db = getDb()
    const [current] = await db
      .select({ profileVersion: projects.profileVersion, profileDisplay: projects.profileDisplay })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!current) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const currentVersion = current.profileVersion
    const values = buildProfileUpdate(parsed.data, currentVersion, current.profileDisplay?.summary ?? '')
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
    console.error('[Profile API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export function buildProfileUpdate(profile: ProjectProfile, currentVersion: number, previousSummary = '') {
  const profilePromptView = buildProjectPromptView(profile)
  const profileDisplay = buildProjectProfileDisplay(profile, previousSummary)

  return {
    profile,
    profileVersion: currentVersion + 1,
    profilePromptView,
    profileDisplay,
    profileUpdatedAt: new Date(),
  }
}

export function toProfileResponse(project: StoredProfileResponse): StoredProfileResponse {
  return {
    profile: project.profile,
    profileVersion: project.profileVersion,
    profilePromptView: project.profilePromptView,
    profileDisplay: project.profileDisplay,
    profileUpdatedAt: project.profileUpdatedAt,
  }
}
