'use client'

/**
 * Dev preview for Organisation → Anweisungen: the standing instruction block
 * every turn in the organization carries.
 *
 * Renders the REAL `OrgInstructionsForm` twice, because the two states answer
 * different questions and only one of them is the interesting one:
 *
 *   - an organization that has written a block, counter part-used;
 *   - an organization that has pasted more than fits, counter over the cap and
 *     Save refused. That is the state the surface exists to make survivable —
 *     an instruction cut at 1500 characters says something its author never
 *     wrote, so the editor refuses rather than truncates.
 *
 * The fetch shim is installed at MODULE scope, not in an effect: a child's
 * effect fires first and would race a parent's fetch patch.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { OrgInstructionsForm } from '@/app/app/(shell)/organization/org-instructions-form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ORG_INSTRUCTIONS_MAX_CHARS } from '@/lib/org-instructions/constants'

const WRITTEN = [
  'Antworten zuerst mit dem Ergebnis, dann mit der Begründung.',
  'Wenn kein Bundesland genannt ist, Wien annehmen und das dazusagen.',
  'Bei Prüfaufträgen immer eine Mängelliste anhängen, auch wenn sie leer ist.',
].join('\n')

/** Twelve characters past the cap — the counter has to say by how much. */
const TOO_LONG = `${WRITTEN}\n${'ü'.repeat(ORG_INSTRUCTIONS_MAX_CHARS + 12 - WRITTEN.length - 1)}`

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __orgInstructionsShim?: boolean }
  if (!w.__orgInstructionsShim) {
    w.__orgInstructionsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/organization/instructions') {
        return Response.json({ instructions: { instructions: WRITTEN } })
      }
      return real(input, init)
    }
  }
}

export default function OrgInstructionsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="org-instructions-preview">
        <Card>
          <CardHeader>
            <CardTitle>Anweisungen</CardTitle>
            <CardDescription>
              Was Piloti für Ihre Organisation dauerhaft beachten soll. Wird bei jeder Anfrage
              mitgegeben.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgInstructionsForm initialInstructions={WRITTEN} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Über der Grenze</CardTitle>
            <CardDescription>
              Der Zähler sagt, um wie viel — und Speichern bleibt gesperrt, statt den Text zu
              kürzen.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgInstructionsForm initialInstructions={TOO_LONG} />
          </CardContent>
        </Card>
      </main>
    </I18nProvider>
  )
}
