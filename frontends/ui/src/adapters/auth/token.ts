// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal JWT decoding helpers for client-side use.
 *
 * These helpers do NOT verify signatures; they only read the payload of a
 * token that has already been issued and validated by WorkOS AuthKit.
 */

/**
 * Extract the `exp` claim from a JWT access token.
 *
 * Returns `undefined` if the token is malformed or has no expiration.
 */
export const getTokenExpiration = (token: string): number | undefined => {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined

    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = typeof atob !== 'undefined' ? atob(base64) : Buffer.from(base64, 'base64').toString('utf8')
    const decoded = JSON.parse(json) as { exp?: unknown }

    return typeof decoded.exp === 'number' ? decoded.exp : undefined
  } catch {
    return undefined
  }
}
