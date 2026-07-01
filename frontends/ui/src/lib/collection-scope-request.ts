// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  buildCollectionScopeHeader,
  computeCollectionScope,
  type ScopeContext,
} from '@/lib/collection-scope'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'

export interface RequestContext {
  projectId?: string
  conversationId?: string
}

function isAuthRequired(): boolean {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

export async function resolveActiveProjectId(
  session: GridSession | null,
  explicitProjectId?: string,
): Promise<string | undefined> {
  if (explicitProjectId) {
    return explicitProjectId
  }

  if (!session) {
    return undefined
  }

  const db = getDb()
  const [row] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.workosUserId, session.userId))
    .limit(1)

  if (row?.prefs && typeof row.prefs === 'object') {
    const activeId = (row.prefs as Record<string, unknown>).active_project_id
    if (typeof activeId === 'string' && activeId) {
      return activeId
    }
  }

  return undefined
}

export async function buildCollectionScopeFromRequest(
  session: GridSession | null,
  context: RequestContext,
): Promise<{
  scope: string[]
  headerValue: string
  projectId: string | undefined
  conversationId: string | undefined
}> {
  const anonymous = !isAuthRequired()

  let projectId = context.projectId
  if (!projectId && session && !anonymous) {
    projectId = await resolveActiveProjectId(session, undefined)
  }

  const conversationId = context.conversationId

  if (projectId && session && !anonymous) {
    await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
  }

  const scope = computeCollectionScope(session, {
    projectId,
    conversationId,
  } satisfies ScopeContext)

  return {
    scope,
    headerValue: buildCollectionScopeHeader(scope),
    projectId,
    conversationId,
  }
}
