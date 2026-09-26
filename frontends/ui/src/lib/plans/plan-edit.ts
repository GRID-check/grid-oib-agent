/**
 * An edit applied to the plan the client holds, before the BFF answers.
 *
 * The block sends each edit as a diff against the plan it holds. Without this,
 * a second change made while the first is in flight is diffed against the
 * plan from before the first, and a sections list sent then would undo it.
 * The BFF's answer still replaces the result: this is the client's best guess
 * of that answer, by the same rules (names resolve against the inventory, an
 * exclusion beats a Grundlage mark, an edit holds a counting plan).
 */

import type { PlanDocument } from '@/lib/runs/plan-documents'
import type { ResearchPlan, ResearchPlanEdit } from './plan-types'

const fold = (name: string): string => name.trim().toLocaleLowerCase()

function resolve(names: readonly string[], inventory: readonly PlanDocument[]): PlanDocument[] {
  const byKey = new Map<string, PlanDocument>()
  for (const doc of inventory) {
    byKey.set(fold(doc.name), doc)
    if (doc.title) byKey.set(fold(doc.title), doc)
  }
  const seen = new Set<string>()
  return names.flatMap((name) => {
    const doc = byKey.get(fold(name))
    if (!doc || seen.has(fold(doc.name))) return []
    seen.add(fold(doc.name))
    return [doc]
  })
}

export function applyPlanEdit(plan: ResearchPlan, edit: ResearchPlanEdit): ResearchPlan {
  const inventory = [...plan.unterlagen, ...(edit.unterlagen ?? [])].filter(
    (doc, index, all) => all.findIndex((other) => fold(other.name) === fold(doc.name)) === index
  )
  const excluded = resolve(edit.ausgeschlossen ?? plan.ausgeschlossen.map((doc) => doc.name), inventory)
  const excludedKeys = new Set(excluded.map((doc) => fold(doc.name)))
  const read = resolve(edit.grundlage ?? plan.grundlage.map((doc) => doc.name), inventory).filter(
    (doc) => !excludedKeys.has(fold(doc.name))
  )
  return {
    ...plan,
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.sections !== undefined ? { sections: edit.sections } : {}),
    ...(edit.genre !== undefined ? { genre: edit.genre } : {}),
    ...(edit.depth !== undefined ? { depth: edit.depth } : {}),
    unterlagen: inventory,
    grundlage: read,
    ausgeschlossen: excluded,
    nurGrundlage: (edit.nurGrundlage ?? plan.nurGrundlage) && read.length > 0,
    ...(plan.status === 'proposed' ? { status: 'held' as const, startsAt: null } : {}),
  }
}
