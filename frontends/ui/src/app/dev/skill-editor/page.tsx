'use client'

/**
 * Dev preview for the two panes that sit beside the skill editor's form: the
 * REAL `SkillDocumentPreview` (the SKILL.md the form is writing, split at the
 * progressive-disclosure seam) and the REAL `SkillReviewPanel` beneath it.
 *
 * Why the fetch shim: the review panel is not a linter, it asks the backend
 * reviewer — `reviewSkill` POSTs to `/api/skills/review` — so without a shim a
 * backend-free capture could only ever show the "could not check" state, which
 * is the one state that says nothing about the surface being reviewed. The
 * fixture answers with findings covering all three severities and all three
 * fields, because severity is carried by icon and colour alone and a screenshot
 * with one severity in it proves nothing about the other two.
 *
 * Why the auto-click: findings do not exist until somebody presses "Skill
 * prüfen", and the harness cannot interact with the page. The driver presses the
 * panel's own button and stops as soon as the findings list is in the DOM, which
 * is also what the registry waits on — so the capture is deterministic rather
 * than a race with an effect.
 *
 * The fixture is a deliberately MEDIOCRE skill. A clean one would render an
 * empty results state and prove only that the request round-tripped; the panel
 * exists to show a first-time author what is wrong with a description that will
 * never be selected, so the draft here has exactly that problem.
 *
 * Pinned to German, like the other preview routes. No `notFound()` of its own —
 * the `/dev` layout is a Server Component and gates every preview route out of
 * production on a server boundary.
 */

import { Suspense, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { SkillEditorDialog } from '@/features/skills/components/skill-editor-dialog'
import { SkillDocumentPreview } from '@/features/skills/components/SkillDocumentPreview'

const SKILL = {
  name: 'brandschutz-check',
  description: 'Prüft den Brandschutz im Projekt.',
  body: `Handle als Brandschutzprüfer für ein Wiener Wohnbauprojekt.

1. Lies die Projektunterlagen und liste jedes brandschutzrelevante Bauteil mit Geschoß und Bezeichnung.
2. Bestimme die Gebäudeklasse aus Bauwerkshöhe, Geschoßanzahl und Nutzung.
3. Prüfe jedes Bauteil gegen OIB-Richtlinie 2 (Feuerwiderstand tragender und trennender Bauteile).
4. Prüfe Fluchtwege gegen OIB-Richtlinie 2.3 (Länge, Breite, Anzahl der Ausgänge).
5. Nenne jede Abweichung mit der genauen Klausel und einem konkreten Korrekturvorschlag.

Nenne fehlende Angaben ausdrücklich als fehlend — nie als erfüllt.`,
  metadata: { 'grid-hidden': 'true', 'grid-cards': 'legal_basis' },
}

const FINDINGS = {
  findings: [
    {
      severity: 'error',
      field: 'description',
      check: '4.8-description-trigger-style',
      message:
        'Die Beschreibung sagt nicht, WANN der Skill einzusetzen ist — der Agent kann ihn dadurch kaum von „einreichplan-checkliste“ unterscheiden.',
      fix: 'Ergänzen Sie den Anlass: „Einsetzen, wenn ein Brandschutznachweis nach OIB-Richtlinie 2 erstellt oder vor der Einreichung gegengeprüft werden soll.“',
    },
    {
      severity: 'warning',
      field: 'name',
      check: '2-naming-quality',
      message:
        'Der Name nennt die Richtlinie nicht, obwohl die Anweisung ausschließlich gegen OIB 2 prüft.',
      fix: 'Benennen Sie den Skill in „oib-brandschutznachweis“ um, damit er im /-Menü neben den übrigen OIB-Skills gefunden wird.',
    },
    {
      severity: 'suggestion',
      field: 'body',
      check: '3-ambiguous-terms',
      message:
        'Schritt 2 setzt die Gebäudeklasse voraus, sagt aber nicht, was zu tun ist, wenn das Projekt keine angibt.',
      fix: 'Halten Sie den Abbruchfall fest: ohne Gebäudeklasse keine Beurteilung, sondern eine Rückfrage.',
    },
  ],
}

// The reviewer lives on the server, so a backend-free route has to answer for
// it — see the module note. Installed once per page load, in front of the real
// fetch, which every other request still reaches.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __skillEditorShim?: boolean }
  if (!w.__skillEditorShim) {
    w.__skillEditorShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/skills/review')) {
        return Response.json(FINDINGS)
      }
      return real(input, init)
    }
  }
}

export default function SkillEditorPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="skill-editor-preview"
        // The editor is a dialog whose panes share one narrow column, so the
        // document and the findings are read at the width they ship at.
        className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-8 p-6"
      >
        {/* The REAL builder, open. `?step=` walks it forward by pressing its
            own „Weiter", so each step can be captured as an author meets it —
            step 1 is the two lines an agent reads every turn, step 3 is the
            check the save waits on. */}
        <Suspense>
          <BuilderAtStep />
        </Suspense>

        <SkillDocumentPreview
          name={SKILL.name}
          description={SKILL.description}
          body={SKILL.body}
          metadata={SKILL.metadata}
        />
      </main>
    </I18nProvider>
  )
}

/**
 * The builder, walked to the requested step by pressing its own „Weiter".
 *
 * One press per frame, looking the button up each time: it only exists once the
 * step before it has rendered, so holding a node would press a button that has
 * been replaced. `document`, not a ref — the dialog renders in a PORTAL. On the
 * last step it presses „Skill prüfen" instead, because the findings, and the
 * save the check unlocks, are what that step is.
 */
function BuilderAtStep(): JSX.Element {
  const target = Number(useSearchParams()?.get('step') ?? '1')

  useEffect(() => {
    if (!Number.isFinite(target) || target <= 1) return
    let stopped = false
    let pressed = 0
    const tick = (): void => {
      if (stopped) return
      if (pressed < target - 1) {
        const next = document.querySelector<HTMLButtonElement>('[data-testid="skill-next"]')
        if (next) {
          next.click()
          pressed += 1
        }
        requestAnimationFrame(tick)
        return
      }
      const check = document.querySelector<HTMLButtonElement>('[data-testid="skill-review-run"]')
      if (check) {
        check.click()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [target])

  return (
    <SkillEditorDialog
      open
      onOpenChange={() => {}}
      skill={{
        ...SKILL,
        id: 'skill-preview',
        origin: 'org',
        enabled: true,
        // Unsorted, which is what a skill written straight into the editor is
        // until somebody files it.
        categoryId: null,
        clonedFrom: null,
        createdAt: null,
        updatedAt: null,
      }}
      onSaved={() => {}}
    />
  )
}
