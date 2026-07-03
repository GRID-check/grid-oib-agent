import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isAuthzError } from '@/lib/auth-utils'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import type { ProjectProfileDisplay } from '@/lib/project-profile/types'

const BACKEND_URL = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '')

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:edit')

    const profileText = await loadProjectPromptView(id)
    if (!profileText) {
      return NextResponse.json({ summary: '' })
    }

    const backendUrl = `${BACKEND_URL}/v1/generate-summary`
    const backendRes = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_text: profileText }),
    })

    if (!backendRes.ok) {
      const errorText = await backendRes.text()
      console.error('[GenerateSummary] Backend error:', backendRes.status, errorText)
      return NextResponse.json({ error: 'Summary generation failed' }, { status: 502 })
    }

    const { summary } = await backendRes.json() as { summary: string }

    const db = getDb()
    const [current] = await db
      .select({ profileDisplay: projects.profileDisplay })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (current?.profileDisplay) {
      const updatedDisplay: ProjectProfileDisplay = {
        ...current.profileDisplay,
        summary,
      }
      await db
        .update(projects)
        .set({ profileDisplay: updatedDisplay })
        .where(and(eq(projects.id, id)))
    }

    invalidateProjectPromptViewCache(id)

    return NextResponse.json({ summary })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[GenerateSummary] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
