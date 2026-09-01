'use client'

/**
 * Dev preview for a manual confirmation that could not be saved.
 *
 * Its own route rather than another block on `/dev/bim-compliance`, because
 * this state does not exist until somebody presses Save: the page drives the
 * form itself and the registry waits on the alert, so the capture is
 * deterministic rather than a race with an effect.
 *
 * The state is worth pinning because of what the failure used to look like —
 * nothing. The request rejected, the form stayed open, and an architect who
 * had just signed off a requirement had every reason to believe it was
 * recorded. On the one surface whose whole purpose is to be a record, a
 * silent write failure is the worst thing it can do.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { IfcCompliancePanel } from '@/features/bim/components/ifc-compliance-panel'
import type { BimRuleResultWithConfirmation } from '@/lib/bim/rules'

const RULE: BimRuleResultWithConfirmation = {
  ruleId: 'oib2-feuerwiderstand-tragend',
  confirmation: null,
  confirmationStale: false,
  richtlinie: 'OIB 2',
  clause: '3',
  titleDe: 'Tragende Bauteile — Feuerwiderstand',
  thresholdDe: 'Feuerwiderstand nach Gebäudeklasse (GK1 R 30 … GK5 REI 90)',
  applicable: true,
  notApplicableReason: undefined,
  passed: 0,
  failed: 0,
  undecidable: 34,
  failures: [],
  unknowns: [
    {
      status: 'undecidable',
      globalId: '0GridFixture00Wall0001',
      name: 'AW 38 Nord',
      storeyName: 'Erdgeschoss',
      reading: 'Kein Feuerwiderstand am Bauteil hinterlegt — erforderlich REI 60',
    },
  ],
  missing: [{ path: 'Pset_WallCommon.FireRating', elements: 34 }],
  truncated: false,
}

export default function BimConfirmationFailedPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <div
      data-testid="bim-confirmation-failed-preview"
      className="bg-background text-foreground min-h-dvh p-6"
    >
      <div className="mx-auto max-w-[820px]">
        <Driver />
      </div>
    </div>
  )
}

/**
 * Opens the note form and presses Save against a rejecting handler.
 *
 * Two steps, each waiting for the button the previous one revealed, so the
 * sequence cannot outrun React's render.
 */
function Driver(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let stopped = false
    // By test id, not by label: the preview renders in whichever locale the
    // harness picks, and a driver keyed on German copy silently does nothing
    // in an English run — which is exactly how this capture first came back
    // showing the untouched form.
    const press = (testId: string): boolean => {
      const button = root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      button?.click()
      return Boolean(button)
    }
    const tick = (): void => {
      if (stopped) return
      if (root.querySelector('[data-testid="bim-confirmation-failed"]')) return
      if (!press('bim-confirm-save')) press('bim-confirm-open')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div ref={rootRef}>
      <IfcCompliancePanel
        rules={[RULE]}
        summary={null}
        shoppingList={[]}
        isLoading={false}
        error={null}
        projectId="p1"
        modelFilename="wohnhaus-beispielgasse_V3.ifc"
        missingFacts={[]}
        askHref="/app/projects/p1/chat?ask=x"
        bcfHref={null}
        onConfirm={() => Promise.reject(new Error('offline'))}
      />
    </div>
  )
}
