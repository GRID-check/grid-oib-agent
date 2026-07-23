/**
 * Platform workflow template item API — update or delete a single template
 * (including the publish/unpublish toggle, which is just a `published` PATCH).
 * Platform owners only (ADR-0016 / ADR-0027).
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { deletePlatformTemplate, updatePlatformTemplate } from '@/lib/platform-workflow-templates/service'
import { updatePlatformTemplateSchema } from '@/lib/platform-workflow-templates/types'

type Ctx = { params: Promise<{ templateId: string }> }

export async function PATCH(request: Request, { params }: Ctx): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    const { templateId } = await params

    const json = await request.json().catch(() => null)
    const parsed = updatePlatformTemplateSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid template', code: 'BAD_REQUEST', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const updated = await updatePlatformTemplate(templateId, parsed.data)
    if (!updated) {
      return NextResponse.json({ error: 'Template not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return NextResponse.json(updated)
  } catch (error) {
    return handleError(error)
  }
}

export async function DELETE(_request: Request, { params }: Ctx): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    const { templateId } = await params

    const removed = await deletePlatformTemplate(templateId)
    if (!removed) {
      return NextResponse.json({ error: 'Template not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return handleError(error)
  }
}

function handleError(error: unknown): Response {
  if (error instanceof PlatformAccessDeniedError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  const denied = authzErrorResponse(error)
  if (denied) return denied
  throw error
}
