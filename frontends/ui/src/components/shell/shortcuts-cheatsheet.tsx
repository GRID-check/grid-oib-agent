'use client'

/**
 * The keyboard-shortcuts cheatsheet (`?`) — a small dialog listing the
 * global shortcuts, so the feature is discoverable without documentation.
 */

import * as React from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-surface-sunken px-1.5 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  )
}

function ShortcutRow({ label, keys }: { label: string; keys: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm">{label}</span>
      <span className="flex shrink-0 items-center gap-1">{keys}</span>
    </div>
  )
}

/** `⌘` on Apple platforms, `Ctrl` elsewhere — resolved client-side only. */
function useModifierLabel(): string {
  const [label, setLabel] = React.useState('Ctrl')
  React.useEffect(() => {
    if (/mac|iphone|ipad|ipod/i.test(window.navigator.platform ?? '')) setLabel('⌘')
  }, [])
  return label
}

export interface ShortcutsCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutsCheatsheet({ open, onOpenChange }: ShortcutsCheatsheetProps) {
  const t = useTranslations('shortcuts.cheatsheet')
  const mod = useModifierLabel()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border">
          <ShortcutRow
            label={t('items.palette')}
            keys={
              <>
                <Key>{mod}</Key>
                <Key>K</Key>
              </>
            }
          />
          <ShortcutRow label={t('items.cheatsheet')} keys={<Key>?</Key>} />
          <ShortcutRow
            label={t('items.projects')}
            keys={
              <>
                <Key>G</Key>
                <span className="text-xs text-muted-foreground">{t('thenSeparator')}</span>
                <Key>P</Key>
              </>
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('disableHint')}</p>
      </DialogContent>
    </Dialog>
  )
}
