'use client'

import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

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
      className="toaster group"
      toastOptions={{
        classNames: {
          // The left edge is uniformly 2px on every toast so the per-tone
          // accent below never changes geometry — only its color. Tones use
          // the signal families (theme colors, so the side-specific utility
          // wins the cascade over `border-border` exactly like a framework
          // `border-l-*` would). Error stays distinguishable from success
          // without color alone: sonner's per-type icon is untouched.
          toast: 'bg-popover text-popover-foreground border-border rounded-xl border-l-2 shadow-md',
          success: 'border-l-status-active',
          error: 'border-l-signal-error',
          warning: 'border-l-source-office',
          info: 'border-l-source-law',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
