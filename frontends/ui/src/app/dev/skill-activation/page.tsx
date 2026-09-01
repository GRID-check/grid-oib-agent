'use client'

/**
 * Dev preview for "Skills verwendet" — the REAL `SkillsUsedDisclosure` in BOTH
 * of its states on one page, because the collapsed line and the opened panel are
 * the two halves of a single claim: a skill being AVAILABLE is not news, a
 * skill's instructions having shaped this answer is.
 *
 * Why the fetch shim: the descriptions are fetched lazily from
 * `/api/skills/invocable` the first time the panel is opened (the names arrive
 * on the answer frame, the descriptions do not), so a backend-free capture would
 * otherwise show the degraded name-only rows for every entry.
 *
 * Why the auto-click: the disclosure is a Radix Collapsible driven by its own
 * `useState`, with no controlled `open` prop — there is no way to render it
 * expanded from the outside, and the harness cannot interact with the page. So
 * the second instance presses its own trigger on mount. This is precisely the
 * kind of thing a preview route is for: driving a component into a state that
 * only exists after a user gesture, without adding a prop to the component that
 * nothing in the product would use.
 *
 * The opened fixture activates three skills and the shim knows only two. The
 * third is a skill that has since been renamed, and the row must keep its name
 * rather than disappear — the answer really was written with it, and a missing
 * row would make the record less true than an incomplete one.
 *
 * Pinned to German, like the other preview routes. No `notFound()` of its own —
 * the `/dev` layout is a Server Component and gates every preview route out of
 * production on a server boundary.
 */

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'

import { I18nProvider } from '@/i18n'
import { SkillsUsedDisclosure } from '@/features/skills/components/SkillsUsedDisclosure'

const INVOCABLE = [
  {
    name: 'oib-brandschutznachweis',
    description:
      'Prüft das Projekt gegen OIB-Richtlinie 2 und listet jede Abweichung mit Klausel und Korrekturvorschlag. Einsetzen, wenn ein Brandschutznachweis erstellt oder vor der Einreichung gegengeprüft werden soll.',
    origin: 'platform',
  },
  {
    name: 'schallschutz-bericht',
    description:
      'Entwirft den Schallschutznachweis nach OIB-Richtlinie 5 aus den Projektunterlagen. Einsetzen, wenn Trennbauteile zwischen Wohnungen oder gegen Stiegenhäuser zu beurteilen sind.',
    origin: 'org',
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __skillActivationShim?: boolean }
  if (!w.__skillActivationShim) {
    w.__skillActivationShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/skills/invocable')) {
        return Response.json({ skills: INVOCABLE })
      }
      return real(input, init)
    }
  }
}

export default function SkillActivationPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="skill-activation-preview"
        // The thread column: the disclosure sits under an answer, and its whole
        // design brief is to stay quiet there.
        className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-8 p-6"
      >
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
            Geschlossen — ein Skill, unter der Antwort
          </h2>
          <SkillsUsedDisclosure skillsActivated={['oib-brandschutznachweis']} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
            Geöffnet — drei Skills, einer davon zwischenzeitlich umbenannt
          </h2>
          <ExpandedDisclosure />
        </section>
      </main>
    </I18nProvider>
  )
}

/**
 * Opens its own disclosure on mount (see the module note on why there is no
 * prop for this), found by test id rather than by label so the driver works in
 * either locale. The trigger TOGGLES, so this retries only while it is missing
 * and stops the moment it has pressed it — a second press would close the panel
 * the capture is waiting for.
 */
function ExpandedDisclosure(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let stopped = false
    const tick = (): void => {
      if (stopped) return
      const trigger = root.querySelector<HTMLButtonElement>('[data-testid="skills-used-trigger"]')
      if (trigger) {
        trigger.click()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div ref={rootRef}>
      <SkillsUsedDisclosure
        skillsActivated={['oib-brandschutznachweis', 'schallschutz-bericht', 'oib-fluchtweg-check']}
      />
    </div>
  )
}
