// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization guards for server components and route handlers.
 */

import { redirect } from 'next/navigation'
import { requireGridSession } from './session'
import type { AuthorizedSession } from './types'

/**
 * Require a signed-in Grid session that has selected a WorkOS organization.
 *
 * Users without an organization are redirected to the organization
 * onboarding flow so the BFF can resolve org-scoped roles and permissions.
 */
export async function requireAuthorizedSession(): Promise<AuthorizedSession> {
  const session = await requireGridSession()

  if (!session.organizationId) {
    redirect('/onboarding/organization')
  }

  return session as AuthorizedSession
}
