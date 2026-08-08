'use client'

/**
 * Dev preview for the keyboard-shortcuts cheatsheet (`?`) — the REAL
 * `ShortcutsCheatsheet`, held open, driven by the real shortcut registry. No
 * fixtures beyond the capability flags: every row, label, icon and keycap on
 * screen is what the registry derives from the live IA, which is exactly what
 * this evidence is for.
 *
 * Variants:
 *   - default           — every capability on: the widest sheet a user can be
 *                         shown (Workflows, Knowledge, Archiv, Inbox,
 *                         Organization, mentions), so the two-column layout is
 *                         exercised at its real density.
 *   - `?variant=minimal`— a plain member with no optional feature enabled: the
 *                         floor. Proves the sheet stays composed when the
 *                         navigation group shrinks and the gated chat row and
 *                         its flag disappear together.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is
 * the product's primary language, so the committed evidence carries the copy
 * most users actually see rather than the developer's own preference.
 */

import { useEffect, useState } from 'react'

import { I18nProvider } from '@/i18n'
// Imported by module path, not through the `components/shell` barrel: the
// barrel also re-exports `org-topbar`, which reaches `@/i18n/server`
// (`server-only` + `next/headers`). Pulling the barrel into a client component
// therefore fails the build.
import { ShortcutsCheatsheet } from '@/components/shell/shortcuts-cheatsheet'

type Variant = 'default' | 'minimal'

const VARIANTS: readonly Variant[] = ['minimal']

const readVariant = (): Variant => {
  if (typeof window === 'undefined') return 'default'
  const value = new URLSearchParams(window.location.search).get('variant') as Variant | null
  return value && VARIANTS.includes(value) ? value : 'default'
}

export default function ShortcutsPreviewPage() {
  const [variant, setVariant] = useState<Variant>('default')
  useEffect(() => setVariant(readVariant()), [])

  const everything = variant === 'default'

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="min-h-dvh bg-background px-4 py-10" data-testid="shortcuts-preview">
        <h1 className="mx-auto mb-6 max-w-2xl font-mono text-xs text-muted-foreground">
          /dev/shortcuts — Tastaturkürzel ({variant})
        </h1>
        <ShortcutsCheatsheet
          open
          onOpenChange={() => {}}
          canViewOrganization={everything}
          showKnowledge={everything}
          showWorkflows={everything}
          canAccessArchiv={everything}
          canCollaborate={everything}
          // Its own flag since ADR-0042, so the preview has to pass it too — the
          // prop defaults to false, and without this the "everything" variant
          // would quietly render a cheatsheet missing the `g i` jump.
          canAccessInbox={everything}
        />
      </main>
    </I18nProvider>
  )
}
