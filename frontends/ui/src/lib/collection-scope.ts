// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GridSession } from './auth/types'

export interface ScopeContext {
  projectId?: string
  conversationId?: string
  baseCollection?: string
}

export function computeCollectionScope(
  _session: GridSession | null,
  context: ScopeContext,
): string[] {
  const scope: string[] = []
  const base = context.baseCollection || process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
  scope.push(base)

  if (context.projectId) {
    scope.push(`proj_${context.projectId}`)
  }

  if (context.conversationId) {
    scope.push(`s_${context.conversationId}`)
  }

  return [...new Set(scope)]
}

export function buildCollectionScopeHeader(scope: string[]): string {
  return Buffer.from(JSON.stringify(scope)).toString('base64url')
}
