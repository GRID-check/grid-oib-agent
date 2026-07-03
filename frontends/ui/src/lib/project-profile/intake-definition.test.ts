// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'

import {
  answersFromProfile,
  buildIntakeProfile,
  formatIntakeAnswer,
  projectIntakeDefinitionV1,
} from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue } from './types'

const definition = projectIntakeDefinitionV1

describe('buildIntakeProfile', () => {
  it('writes confirmed facts and goals through the shared patch engine', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      project_name: 'Haus am See',
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      primary_goal: 'Confirm fire strategy',
    }

    const profile = buildIntakeProfile(answers, definition)

    // Shape matches the schema exactly (same engine as chat-driven edits).
    expect(() => ProjectProfileSchema.parse(profile)).not.toThrow()
    expect(profile.facts.project_name?.value).toBe('Haus am See')
    expect(profile.facts.project_name?.source).toBe('onboarding')
    expect(profile.facts.project_name?.confidence).toBe('confirmed')
    expect(profile.facts.anzahl_einheiten?.value).toBe(12)
    expect(profile.goals.primary_goal).toBe('Confirm fire strategy')
  })

  it('records relevant-but-unanswered questions in unknowns', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'wohnen',
    }

    const profile = buildIntakeProfile(answers, definition)

    // project_name was skipped and is relevant -> becomes an unknown.
    expect(profile.unknowns).toContain('project_name')
    // anzahl_einheiten is now relevant (wohnen) and unanswered -> unknown.
    expect(profile.unknowns).toContain('anzahl_einheiten')
    // anzahl_betten only applies to beherbergung -> NOT an unknown here.
    expect(profile.unknowns).not.toContain('anzahl_betten')
  })

  it('does not treat conditionally-hidden questions as unknown', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'buero',
    }

    const profile = buildIntakeProfile(answers, definition)
    expect(profile.unknowns).not.toContain('anzahl_einheiten')
    expect(profile.unknowns).not.toContain('anzahl_betten')
    expect(profile.unknowns).not.toContain('sicherheitskategorie')
  })
})

describe('answersFromProfile', () => {
  it('round-trips a built profile back into wizard answers for edit mode', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      project_name: 'Haus am See',
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      grundgrenze: true,
      primary_goal: 'Confirm fire strategy',
    }

    const profile = buildIntakeProfile(answers, definition)
    const restored = answersFromProfile(profile, definition)

    expect(restored.project_name).toBe('Haus am See')
    expect(restored.hauptnutzung).toBe('wohnen')
    expect(restored.anzahl_einheiten).toBe(12)
    expect(restored.grundgrenze).toBe(true)
    expect(restored.primary_goal).toBe('Confirm fire strategy')
  })
})

describe('formatIntakeAnswer', () => {
  const useQuestion = definition.stages[0].questions.find((q) => q.id === 'hauptnutzung')!

  it('renders option labels rather than raw values', () => {
    expect(formatIntakeAnswer(useQuestion, 'wohnen')).toBe('Residential')
  })

  it('renders a dash for missing answers', () => {
    expect(formatIntakeAnswer(useQuestion, undefined)).toBe('—')
  })
})
