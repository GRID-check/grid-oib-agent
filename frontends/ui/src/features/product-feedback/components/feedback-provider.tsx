'use client'

/**
 * One feedback dialog for the whole shell, opened from anywhere.
 *
 * The avatar menu, the org header and any later entry point (a command in ⌘K,
 * an error screen's "report this") call {@link useOpenFeedback} instead of
 * each mounting its own dialog, so there is one form, one reset, and one place
 * the reporter's email reaches the contact hint. The same shape the product
 * tour uses (`useStartProductTour`).
 */

import type { JSX } from 'react'
import * as React from 'react'
import type { ProductFeedbackKind } from '@/lib/product-feedback/types'
import { FeedbackDialog } from './feedback-dialog'

type OpenFeedback = (kind?: ProductFeedbackKind) => void

const OpenFeedbackContext = React.createContext<OpenFeedback | null>(null)

const noop: OpenFeedback = () => undefined

/** Opens the shell's feedback dialog; a no-op outside the provider. */
export function useOpenFeedback(): OpenFeedback {
  return React.useContext(OpenFeedbackContext) ?? noop
}

/** Whether a feedback dialog is mounted above — entry points hide themselves without one. */
export function useFeedbackAvailable(): boolean {
  return React.useContext(OpenFeedbackContext) !== null
}

export function FeedbackProvider({
  userEmail = null,
  children,
}: {
  userEmail?: string | null
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<ProductFeedbackKind>('bug')

  const openFeedback = React.useCallback<OpenFeedback>((next) => {
    setKind(next ?? 'bug')
    setOpen(true)
  }, [])

  return (
    <OpenFeedbackContext.Provider value={openFeedback}>
      {children}
      <FeedbackDialog open={open} onOpenChange={setOpen} defaultKind={kind} userEmail={userEmail} />
    </OpenFeedbackContext.Provider>
  )
}
