'use client'

/**
 * Modul I — every document slot a project can fill, in one place.
 *
 * Generated from the role registry rather than hand-listed, so adding a role is
 * one entry in `document-roles.ts` and this surface follows. The order and the
 * "dringend empfohlen" flag come from the same `recommendedWhen` conditions the
 * intake questions use, which is what stops the checklist and the questions
 * disagreeing about what a project is.
 *
 * Only the recommended slots are open. The first build rendered all fifteen
 * expanded — a full upload control, a picker and a drop zone each — and the
 * screenshot made the problem obvious: a wall of identical boxes where the four
 * that matter for this project are indistinguishable from the eleven that do
 * not. The rest collapse to one line and open on click, which is also the
 * honest shape of the thing: a checklist, not a form.
 */

import { useMemo, useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DOCUMENT_ROLE_DEFINITIONS, recommendedRoles } from '@/lib/project-profile/document-roles'
import type { DocumentRole } from '@/lib/project-profile/document-roles'
import type { BauwerkInstance } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { DocumentRoleField } from './document-role-field'

interface ProjektgrundlagenStepProps {
  projectId: string
  answers: Record<string, ProjectPrimitiveValue>
  bauwerke: BauwerkInstance[]
}

interface Slot {
  key: string
  role: DocumentRole
  label: string
  scopeInstanceId: string | null
  recommended: boolean
}

export function ProjektgrundlagenStep({ projectId, answers, bauwerke }: ProjektgrundlagenStepProps) {
  const slots = useMemo<Slot[]>(() => {
    const projectRecommended = new Set(recommendedRoles(answers))
    const perBauwerk = new Map<string, Set<DocumentRole>>(
      bauwerke.map((bauwerk) => [bauwerk.id, new Set(recommendedRoles(answers, bauwerk.id))])
    )

    const collected: Slot[] = []
    for (const definition of DOCUMENT_ROLE_DEFINITIONS) {
      if (definition.scope === 'bauwerk') {
        // One slot per building, because the binding is per building. A single
        // "Bestandspläne" box would have nowhere to put the second building's.
        for (const bauwerk of bauwerke) {
          collected.push({
            key: `${definition.role}@${bauwerk.id}`,
            role: definition.role,
            label: `${definition.label} — ${bauwerk.name}`,
            scopeInstanceId: bauwerk.id,
            recommended: perBauwerk.get(bauwerk.id)?.has(definition.role) ?? false,
          })
        }
        continue
      }
      collected.push({
        key: definition.role,
        role: definition.role,
        label: definition.label,
        scopeInstanceId: null,
        recommended: projectRecommended.has(definition.role),
      })
    }
    return collected
  }, [answers, bauwerke])

  const recommended = slots.filter((slot) => slot.recommended)
  const optional = slots.filter((slot) => !slot.recommended)

  return (
    <div className="space-y-6">
      {recommended.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Für dieses Projekt besonders wichtig</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {recommended.length === 1
                ? 'Diese Unterlage ergibt sich aus Ihren Angaben.'
                : `Diese ${recommended.length} Unterlagen ergeben sich aus Ihren Angaben.`}{' '}
              Ohne sie beantwortet Piloti Fragen dazu nur unter Vorbehalt.
            </p>
          </div>
          <ul className="space-y-3">
            {recommended.map((slot) => (
              <li key={slot.key} className="rounded-xl border bg-card px-4 py-3.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{slot.label}</span>
                  <Badge variant="info">dringend empfohlen</Badge>
                </div>
                <DocumentRoleField
                  projectId={projectId}
                  role={slot.role}
                  scopeInstanceId={slot.scopeInstanceId}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {optional.length > 0 && (
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">Weitere Unterlagen</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Optional, und jederzeit später ergänzbar.
            </p>
          </div>
          <ul className="divide-y rounded-xl border bg-card">
            {optional.map((slot) => (
              <CollapsedSlot key={slot.key} slot={slot} projectId={projectId} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function CollapsedSlot({ slot, projectId }: { slot: Slot; projectId: string }) {
  const [open, setOpen] = useState(false)
  const panelId = `grundlage-${slot.key.replace(/[^a-z0-9]/gi, '-')}`

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 ease-out hover:bg-muted/40 motion-reduce:transition-none"
      >
        <span className="min-w-0 flex-1 truncate text-sm">{slot.label}</span>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {/* Mounted only once opened. The store means this is no longer about
          request count — it is about weight: an upload control, a picker and a
          drop zone for every one of eleven optional slots is the wall this
          collapse exists to prevent. */}
      {open && (
        <div id={panelId} className="border-t px-4 py-3.5">
          <DocumentRoleField
            projectId={projectId}
            role={slot.role}
            scopeInstanceId={slot.scopeInstanceId}
          />
        </div>
      )}
    </li>
  )
}
