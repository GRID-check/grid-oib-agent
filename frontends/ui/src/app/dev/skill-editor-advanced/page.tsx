'use client'

/**
 * Dev preview for the skill editor's advanced section — the folded-away
 * SKILL.md editor that writes the whole document back into the form.
 *
 * It gets a route of its own because it lives at the BOTTOM of a tall dialog:
 * the `/dev/skill-editor` shot shows the form above the fold, and this section
 * never appears in it. Both of the states worth looking at are here on one
 * page, because the only thing the section says while it is open is which of
 * them it is in:
 *
 *  - a document that parses and differs from the form — "apply" live;
 *  - a document that does not parse — the named reason, and "apply" refused.
 *
 * A driver opens both and types the second one's text, since the section seeds
 * its draft from the form when it opens and there is no other way to reach a
 * broken draft. Typing goes through the native value setter so React sees a
 * real input event rather than a mutated DOM node.
 *
 * Pinned to German, like the other preview routes.
 */

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'

import { I18nProvider } from '@/i18n'
import { SkillRawDocumentSection } from '@/features/skills/components/SkillRawDocumentSection'
import { renderSkillDocument } from '@/features/skills/lib/skill-document'

const DOCUMENT = renderSkillDocument({
  name: 'brandschutz-check',
  description:
    'Prüft Bauteile und Fluchtwege gegen OIB-Richtlinie 2. Einsetzen, wenn ein Brandschutznachweis erstellt oder vor der Einreichung gegengeprüft werden soll.',
  body: 'Handle als Brandschutzprüfer.\n\n1. Bestimme die Gebäudeklasse.\n2. Prüfe jedes Bauteil gegen OIB-Richtlinie 2.',
  metadata: { 'grid-auto-invoke': 'false', 'grid-hidden': 'true', 'grid-cards': 'legal_basis' },
})

/** Frontmatter that was never closed — the commonest paste accident. */
const BROKEN = `---
name: brandschutz-check
description: Prüft Bauteile und Fluchtwege gegen OIB-Richtlinie 2.

Handle als Brandschutzprüfer.`

export default function SkillEditorAdvancedPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="skill-editor-advanced-preview"
        className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-8 p-6"
      >
        <Driver />
      </main>
    </I18nProvider>
  )
}

function Driver(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let stopped = false

    const type = (element: HTMLTextAreaElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const tick = (): void => {
      if (stopped) return
      const sections = root.querySelectorAll<HTMLElement>('[data-testid="skill-raw-document"]')
      if (sections.length < 2) {
        requestAnimationFrame(tick)
        return
      }
      const triggers = root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="skill-raw-document"] > button',
      )
      // Open both, then wait a frame for the collapsible content to mount.
      for (const trigger of triggers) {
        if (trigger.getAttribute('data-state') !== 'open') trigger.click()
      }
      requestAnimationFrame(() => {
        if (stopped) return
        const areas = root.querySelectorAll<HTMLTextAreaElement>(
          '[data-testid="skill-raw-document"] textarea',
        )
        if (areas.length < 2) {
          requestAnimationFrame(tick)
          return
        }
        type(areas[0], DOCUMENT.replace('grid-cards: legal_basis', 'grid-cards: comparison_table'))
        type(areas[1], BROKEN)
      })
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div ref={rootRef} className="flex flex-col gap-8">
      <SkillRawDocumentSection document={DOCUMENT} onApply={() => {}} />
      <SkillRawDocumentSection document={DOCUMENT} onApply={() => {}} />
    </div>
  )
}
