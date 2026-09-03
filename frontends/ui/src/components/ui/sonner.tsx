'use client'

import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * Toast durations, owned here rather than at the ~40 call sites.
 *
 * NOTE on the error case: sonner 2.x exposes only ONE central duration (the
 * `duration` prop below, the fallback for every toast a call site creates
 * without its own). A longer error duration (6000ms) is therefore not
 * expressible from this file — it would need each `toast.error(…)` call to
 * pass `duration: 6000`, and those calls belong to other surfaces. Until that
 * is centralized behind a shared `notify` helper, errors share the default
 * below; the longer read is carried by persistence of attention (the error
 * tone below), not by time.
 */
const TOAST_DURATION_MS = 4000

function Toaster({ ...props }: ToasterProps) {
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light')

  React.useEffect(() => {
    const root = document.documentElement

    const updateTheme = () => {
      setTheme(root.classList.contains('dark') ? 'dark' : 'light')
    }

    updateTheme()

    const observer = new MutationObserver(updateTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  return (
    <Sonner
      theme={theme}
      position="top-right"
      richColors={false}
      duration={TOAST_DURATION_MS}
      gap={8}
      className="toaster group"
      toastOptions={{
        classNames: {
          // The background lives on the per-tone entries rather than here, so
          // the error tone can carry its own body without fighting the base
          // for the same `bg-*` (sonner concatenates the two, and two
          // backgrounds resolve by stylesheet order — invisible in review).
          // Every non-error tone stays monochrome (`bg-popover`); error alone
          // gains the danger-subtle body. Icons are untouched throughout, so
          // error stays distinguishable without color alone.
          // The left edge is uniformly 2px on every toast so the per-tone
          // accent below never changes geometry — only its color. Tones use
          // the signal families (theme colors, so the side-specific utility
          // wins the cascade over `border-border` exactly like a framework
          // `border-l-*` would).
          toast: 'text-popover-foreground border-border rounded-xl border-l-2 shadow-md',
          default: 'bg-popover',
          loading: 'bg-popover',
          success: 'border-l-status-active bg-popover',
          error: 'border-l-signal-error bg-danger-subtle',
          warning: 'border-l-source-office bg-popover',
          info: 'border-l-source-law bg-popover',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
