// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const isAuthzError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message === 'not found' ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}
