// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { StatusScreen } from '@/components/brand/status-screen'

/**
 * Route-level error boundary. Catches thrown errors (including the plain
 * Error('Not found') that requireProjectAccess raises on permission denial)
 * and renders GRID's own chrome instead of Next's default crash page.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[route error]', error)
  }, [error])

  const isAccess = /not found|forbidden|unauthorized|access/i.test(error.message)

  return (
    <StatusScreen
      code={isAccess ? 'Access' : 'Error'}
      title={isAccess ? 'You don’t have access to this' : 'Something went wrong'}
      description={
        isAccess
          ? 'This project may have been moved, or your access was changed. Check with a project admin if you think this is a mistake.'
          : 'An unexpected error occurred. You can try again, or head back to your projects.'
      }
      actions={
        <>
          {!isAccess && (
            <Button variant="outline" onClick={reset}>
              Try again
            </Button>
          )}
          <Button asChild>
            <Link href="/projects">Back to projects</Link>
          </Button>
        </>
      }
    />
  )
}
