import { notFound } from 'next/navigation'
import { type ReactNode } from 'react'

/**
 * Server gate for every `/dev/*` preview route.
 *
 * The previews are fixture-driven component galleries, not product surfaces, so
 * they must not resolve outside development. Each page used to gate itself, but
 * a preview page is a `'use client'` component and `notFound()` is a server
 * primitive — thrown from a client render it is not reliably intercepted, so a
 * production request could land on a client-side error instead of a 404.
 *
 * This layout is a Server Component, so the check runs on a server boundary and
 * every nested preview route inherits it: none can forget the gate, and no new
 * preview has to remember to add one.
 */
export default function DevLayout({ children }: { children: ReactNode }): ReactNode {
  if (process.env.NODE_ENV !== 'development') notFound()
  return children
}
