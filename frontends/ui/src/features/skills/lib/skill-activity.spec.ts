/**
 * @vitest-environment node
 */

/**
 * The single label authority for skills.
 *
 * Three surfaces name a skill on one turn — the live header line, the
 * Herleitung chip and the post-hoc `SkillsUsedDisclosure` — and they must never
 * disagree. These tests pin the degradation ladder (title → name → drop) and
 * the parsing that feeds it, because that is the contract the three surfaces
 * share.
 */

import { describe, test, expect } from 'vitest'
import {
  isSkillSelectionStepName,
  isSkillStepName,
  isUseSkillStepName,
  liveSkillActivity,
  parseSkillActivities,
  parseSkillActivity,
  skillLabel,
  skillLabelForStep,
  skillLiveText,
  skillNameFromStepName,
} from './skill-activity'

describe('step-name recognition', () => {
  test.each([
    ['skill:oib-brandschutz', true],
    ['skill:a', true],
    ['skill_selection', false],
    ['use_skill', false],
    ['web_search_tool', false],
  ])('isSkillStepName(%s) === %s', (name, expected) => {
    expect(isSkillStepName(name)).toBe(expected)
  })

  test('skill_selection and use_skill are recognised separately', () => {
    expect(isSkillSelectionStepName('skill_selection')).toBe(true)
    expect(isUseSkillStepName('use_skill')).toBe(true)
    expect(isUseSkillStepName('skill:a')).toBe(false)
  })

  test('the LLM\'s "Tool:" announcement prefix does not hide the step', () => {
    // `parseFunctionName` only strips "Function Start/Complete:", so an
    // announced call arrives as `Tool: use_skill` and would otherwise slip past
    // every rule keyed on the bare name.
    expect(isUseSkillStepName('Tool: use_skill')).toBe(true)
    expect(isSkillStepName('Tool: skill:a')).toBe(true)
    expect(skillNameFromStepName('Tool: skill:a')).toBe('a')
  })

  test('the skill name is carried by the step name itself', () => {
    expect(skillNameFromStepName('skill:oib-brandschutz')).toBe('oib-brandschutz')
    expect(skillNameFromStepName('skill:')).toBeNull()
    expect(skillNameFromStepName('web_search_tool')).toBeNull()
  })
})

describe('parseSkillActivity', () => {
  test('reads the documented payload and camelCases it', () => {
    const activity = parseSkillActivity(
      JSON.stringify({
        phase: 'loaded',
        name: 'a',
        title: 'Alpha',
        description: 'd',
        origin: 'org',
        forced: true,
        body_chars: 4096,
      })
    )
    expect(activity).toEqual({
      phase: 'loaded',
      name: 'a',
      title: 'Alpha',
      description: 'd',
      origin: 'org',
      forced: true,
      bodyChars: 4096,
    })
  })

  test('reads the round-level skill_selection shape, which carries no name', () => {
    const activity = parseSkillActivity(
      JSON.stringify({ phase: 'offered', offered_count: 6, forced_names: ['a'] })
    )
    expect(activity).toEqual({ phase: 'offered', offeredCount: 6, forcedNames: ['a'] })
  })

  test('takes the LAST phase when several have accumulated on one step', () => {
    // The store appends each phase's payload to the same step, so the blob holds
    // them in run order and the newest is the current state.
    const blob = [
      JSON.stringify({ phase: 'offered', name: 'a' }),
      JSON.stringify({ phase: 'activated', name: 'a' }),
      JSON.stringify({ phase: 'loaded', name: 'a' }),
    ].join('\n')
    expect(parseSkillActivity(blob)?.phase).toBe('loaded')
  })

  test('survives a pretty-printed payload and a brace inside a string', () => {
    const blob = `{\n  "phase": "activated",\n  "name": "a",\n  "description": "uses {curly} braces"\n}`
    expect(parseSkillActivity(blob)).toMatchObject({ phase: 'activated', name: 'a' })
  })

  test('one malformed object does not cost us a well-formed one', () => {
    const blob = `{not json}\n${JSON.stringify({ phase: 'activated', name: 'a' })}\n{ also bad`
    expect(parseSkillActivity(blob)?.name).toBe('a')
  })

  test('every phase on a step is kept, oldest first', () => {
    const blob = [
      JSON.stringify({ kind: 'skill', channel: 'live', phase: 'activated', name: 'a', title: 'Alpha' }),
      JSON.stringify({ kind: 'skill', channel: 'technical', phase: 'loaded', name: 'a', body_chars: 9 }),
    ].join('\n')
    expect(parseSkillActivities(blob).map((a) => a.phase)).toEqual(['activated', 'loaded'])
  })

  test('an unknown field is tolerated, a missing phase is not', () => {
    expect(parseSkillActivity(JSON.stringify({ phase: 'activated', name: 'a', future: 1 }))).toMatchObject({
      phase: 'activated',
    })
    expect(parseSkillActivity(JSON.stringify({ name: 'a' }))).toBeNull()
    expect(parseSkillActivity(JSON.stringify({ phase: 'invented', name: 'a' }))).toBeNull()
  })

  test('a mistyped optional field degrades to absent, not to a dead step', () => {
    const activity = parseSkillActivity(
      JSON.stringify({ phase: 'activated', name: 'a', body_chars: 'lots' })
    )
    expect(activity).toEqual({ phase: 'activated', name: 'a' })
  })

  test('empty and absent payloads yield null', () => {
    expect(parseSkillActivity('')).toBeNull()
    expect(parseSkillActivity(undefined)).toBeNull()
    expect(parseSkillActivity('   ')).toBeNull()
  })
})

describe('skillLabel — the one naming rule', () => {
  test('an authored title wins, in proportional text', () => {
    expect(skillLabel({ name: 'oib-brandschutz', title: 'Brandschutznachweis' })).toEqual({
      text: 'Brandschutznachweis',
      mono: false,
    })
  })

  test('a bare identifier falls back to font-mono — how the disclosure has always shown it', () => {
    expect(skillLabel({ name: 'oib-brandschutz' })).toEqual({
      text: 'oib-brandschutz',
      mono: true,
    })
  })

  test('nothing to say means the row is dropped, not rendered blank', () => {
    expect(skillLabel({})).toBeNull()
    expect(skillLabel({ name: '   ', title: '' })).toBeNull()
    expect(skillLabel(null)).toBeNull()
    expect(skillLabel(undefined)).toBeNull()
  })

  test('a name is never rewritten — no title-casing, no snake_case expansion', () => {
    expect(skillLabel({ name: 'oib_brand_schutz' })?.text).toBe('oib_brand_schutz')
  })
})

describe('skillLabelForStep', () => {
  test('prefers the payload identity', () => {
    expect(
      skillLabelForStep('skill:a', JSON.stringify({ phase: 'activated', name: 'a', title: 'Alpha' }))
    ).toEqual({ text: 'Alpha', mono: false })
  })

  test('falls back to the name in the step name when the payload is unusable', () => {
    expect(skillLabelForStep('skill:oib-brandschutz', 'garbage')).toEqual({
      text: 'oib-brandschutz',
      mono: true,
    })
  })

  test('a step with no skill identity anywhere yields null', () => {
    expect(skillLabelForStep('use_skill', '')).toBeNull()
  })
})

/**
 * The live line is stricter than the label ladder.
 *
 * A bare id in a status sentence is worse than silence, so the backend marks a
 * titleless activation `technical` and withholds its `text`. These tests pin
 * that we honour that rather than falling back to the id — and that `loaded`,
 * which lands on the SAME step a moment later, does not erase the sentence.
 */
describe('liveSkillActivity / skillLiveText', () => {
  const activated = {
    kind: 'skill',
    channel: 'live',
    phase: 'activated',
    name: 'oib-brandschutznachweis',
    title: 'Brandschutznachweis',
    text: 'Skill „Brandschutznachweis“ wird angewendet',
  }
  const loaded = {
    kind: 'skill',
    channel: 'technical',
    phase: 'loaded',
    name: 'oib-brandschutznachweis',
    title: 'Brandschutznachweis',
    body_chars: 4096,
  }

  test('an activation with a title speaks, in the backend\'s own words', () => {
    expect(skillLiveText(JSON.stringify(activated))).toBe(
      'Skill „Brandschutznachweis“ wird angewendet'
    )
  })

  test('the forced wording is carried through rather than re-derived', () => {
    // "wurde angefordert" vs "wird angewendet" is a fact about WHO decided; a
    // frontend template could not know it, so the sentence is not rebuilt here.
    const forced = { ...activated, forced: true, text: 'Skill „Brandschutznachweis“ wurde angefordert' }
    expect(skillLiveText(JSON.stringify(forced))).toBe('Skill „Brandschutznachweis“ wurde angefordert')
  })

  test('loaded arriving on the same step does not blank the line', () => {
    const blob = [JSON.stringify(activated), JSON.stringify(loaded)].join('\n')
    expect(skillLiveText(blob)).toBe('Skill „Brandschutznachweis“ wird angewendet')
    // The state is still the newest phase — only the LIVE line skips backwards.
    expect(parseSkillActivity(blob)?.phase).toBe('loaded')
  })

  test('a titleless activation is silent, and no title is invented', () => {
    const untitled = { kind: 'skill', channel: 'technical', phase: 'activated', name: 'oib-2024' }
    expect(liveSkillActivity(JSON.stringify(untitled))).toBeNull()
    expect(skillLiveText(JSON.stringify(untitled))).toBeNull()
    // …but the chip and the disclosure may still name it by its id.
    expect(skillLabelForStep('skill:oib-2024', JSON.stringify(untitled))).toEqual({
      text: 'oib-2024',
      mono: true,
    })
  })

  test('an offered event never reaches the live line', () => {
    const offered = { kind: 'skill', channel: 'technical', phase: 'offered', offered_count: 6 }
    expect(skillLiveText(JSON.stringify(offered))).toBeNull()
  })
})
