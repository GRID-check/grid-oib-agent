/**
 * Platform workflow templates API — list every template (drafts included) and
 * create a new one. Platform owners only (ADR-0016 / ADR-0027). The create body
 * is the JSON interchange shape, so the UI's file-import path posts here too.
 *
 * Not gated by the per-org workflows feature flag: authoring the shared catalog
 * is a platform-owner capability independent of any tenant's rollout state. The
 * catalog's org-facing READ (the gallery) is where the flag applies.
 */

import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { createPlatformTemplate, listPlatformTemplates } from '@/lib/platform-workflow-templates/service'
import { createPlatformTemplateSchema } from '@/lib/platform-workflow-templates/types'

export async function GET(): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    return NextResponse.json({ templates: await listPlatformTemplates() })
  } catch (error) {
    return handleError(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    // requirePlatformOwner throws for a null session; this narrows the type.
    if (!session) throw new PlatformAccessDeniedError()

    const json = await request.json().catch(() => null)
    const parsed = createPlatformTemplateSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid template', code: 'BAD_REQUEST', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const template = await createPlatformTemplate(parsed.data, {
      userId: session.userId,
      email: session.email ?? null,
    })
    return NextResponse.json(template, { status: 201 })
  } catch (error) {
    return handleError(error)
  }
}

function handleError(error: unknown): Response {
  if (error instanceof PlatformAccessDeniedError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'Invalid template', code: 'BAD_REQUEST', details: error.flatten() },
      { status: 400 },
    )
  }
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  const denied = authzErrorResponse(error)
  if (denied) return denied
  throw error
}
