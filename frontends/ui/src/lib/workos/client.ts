// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Singleton WorkOS Node SDK client.
 *
 * The runtime API key is required for server-side calls to WorkOS (organizations,
 * user management, FGA, etc.).
 */

import { WorkOS } from '@workos-inc/node'

let workos: WorkOS | null = null

export function getWorkOS(): WorkOS {
  if (workos) {
    return workos
  }

  const apiKey = process.env.WORKOS_API_KEY

  if (!apiKey) {
    throw new Error('WORKOS_API_KEY is required')
  }

  workos = new WorkOS(apiKey)

  return workos
}
