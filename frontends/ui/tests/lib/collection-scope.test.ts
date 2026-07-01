// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import { buildCollectionScopeHeader, computeCollectionScope } from '@/lib/collection-scope'

const baseSession = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
}

describe('computeCollectionScope', () => {
  it('always includes base corpus', () => {
    expect(computeCollectionScope(baseSession, {})).toEqual(['oib_knowledge'])
  })

  it('adds project corpus when projectId is provided', () => {
    expect(computeCollectionScope(baseSession, { projectId: 'abc' })).toEqual([
      'oib_knowledge',
      'proj_abc',
    ])
  })

  it('adds conversation corpus with s_ prefix', () => {
    expect(computeCollectionScope(baseSession, { conversationId: 'uuid-123' })).toEqual([
      'oib_knowledge',
      's_uuid-123',
    ])
  })

  it('returns ordered base, project, conversation', () => {
    expect(
      computeCollectionScope(baseSession, { projectId: 'abc', conversationId: 'uuid-123' }),
    ).toEqual(['oib_knowledge', 'proj_abc', 's_uuid-123'])
  })
})

describe('buildCollectionScopeHeader', () => {
  it('encodes scope as base64url JSON', () => {
    const scope = ['oib_knowledge', 'proj_abc', 's_uuid-123']
    const header = buildCollectionScopeHeader(scope)
    expect(Buffer.from(header, 'base64url').toString('utf-8')).toEqual(
      JSON.stringify(scope),
    )
  })
})
