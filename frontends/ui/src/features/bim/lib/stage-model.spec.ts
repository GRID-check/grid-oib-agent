import { describe, expect, it } from 'vitest'
import type { BimModelSummary } from '@/lib/bim/types'
import {
  formatLevelElevation,
  humaniseIfcType,
  levelElevation,
  pickStageModel,
  readableIfcType,
  stageLevels,
  stageModelLabel,
} from './stage-model'

function summary(storeys: BimModelSummary['storeys']): BimModelSummary {
  return { storeys } as unknown as BimModelSummary
}

function storey(name: string | null, elevation: number | null, elementCount = 0) {
  return { globalId: null, expressId: 1, name, elevation, elementCount }
}

describe('stageLevels', () => {
  it('puts the top floor at the top, the way a section is drawn', () => {
    const levels = stageLevels(
      summary([storey('Erdgeschoss', 0), storey('Dachgeschoss', 6.4), storey('Keller', -2.8)])
    )
    expect(levels.map((level) => level.name)).toEqual(['Dachgeschoss', 'Erdgeschoss', 'Keller'])
  })

  it('sorts a storey with no elevation last rather than treating it as ground level', () => {
    // An unplaced storey is UNKNOWN, not at zero. Sorting it as zero would drop
    // it between the basement and the first floor and assert a position the
    // file never published.
    const levels = stageLevels(summary([storey('Zwischenebene', null), storey('Keller', -2.8)]))
    expect(levels.map((level) => level.name)).toEqual(['Keller', 'Zwischenebene'])
  })

  it('drops storeys the export left unnamed, which cannot be addressed in a link', () => {
    const levels = stageLevels(summary([storey(null, 0), storey('   ', 3), storey('EG', 0)]))
    expect(levels.map((level) => level.name)).toEqual(['EG'])
  })

  it('carries the element count through, so the rail can say how full a level is', () => {
    expect(stageLevels(summary([storey('EG', 0, 412)]))[0].elementCount).toBe(412)
  })

  it('survives a model with no summary at all', () => {
    expect(stageLevels(null)).toEqual([])
    expect(stageLevels(undefined)).toEqual([])
  })

  it('treats a non-finite elevation as absent', () => {
    expect(stageLevels(summary([storey('EG', Number.NaN)]))[0].elevation).toBeNull()
  })
})

describe('levelElevation', () => {
  const model = summary([storey('EG', 0), storey('OG1', 3.2)])

  it('finds the height a cut should default to', () => {
    expect(levelElevation(model, 'OG1')).toBe(3.2)
  })

  it('is null for no selection and for a storey this model does not have', () => {
    expect(levelElevation(model, null)).toBeNull()
    expect(levelElevation(model, 'OG7')).toBeNull()
  })
})

describe('stageModelLabel', () => {
  it('drops the extension, because the whole rail is IFCs', () => {
    expect(stageModelLabel('Haus-A_v3.ifc')).toBe('Haus-A_v3')
    expect(stageModelLabel('Haus-A.IFCZIP')).toBe('Haus-A')
  })

  it('leaves a name that only looks like an extension alone', () => {
    expect(stageModelLabel('Haus.ifc.backup')).toBe('Haus.ifc.backup')
  })
})

describe('pickStageModel', () => {
  const models = [
    { filename: 'Haus-A.ifc', status: 'ready', updatedAt: '2026-01-01T00:00:00.000Z' },
    { filename: 'Haus-B.ifc', status: 'ready', updatedAt: '2026-03-01T00:00:00.000Z' },
    { filename: 'Haus-C.ifc', status: 'extracting', updatedAt: '2026-06-01T00:00:00.000Z' },
  ]

  it('opens the model a link names', () => {
    expect(pickStageModel(models, 'Haus-A.ifc')?.filename).toBe('Haus-A.ifc')
  })

  it('matches case-insensitively, because a link is typed as often as it is copied', () => {
    expect(pickStageModel(models, 'haus-b.IFC')?.filename).toBe('Haus-B.ifc')
  })

  it('still resolves after the upload was renamed around the name in the link', () => {
    const renamed = [{ filename: 'Haus-A (final).ifc', status: 'ready', updatedAt: 'x' }]
    expect(pickStageModel(renamed, 'Haus-A')?.filename).toBe('Haus-A (final).ifc')
  })

  it('defaults to the newest READY model, not the newest model', () => {
    // Haus-C is newer but still extracting: opening onto it shows a progress
    // bar where a building should be, which reads as a broken viewer.
    expect(pickStageModel(models, null)?.filename).toBe('Haus-B.ifc')
  })

  it('falls back to the newest of anything when nothing is ready yet', () => {
    const pending = [
      { filename: 'a.ifc', status: 'extracting', updatedAt: '2026-01-01' },
      { filename: 'b.ifc', status: 'failed', updatedAt: '2026-02-01' },
    ]
    expect(pickStageModel(pending, null)?.filename).toBe('b.ifc')
  })

  it('falls back rather than returning nothing when the link names a stranger', () => {
    expect(pickStageModel(models, 'nope.ifc')?.filename).toBe('Haus-B.ifc')
  })

  it('is null for a project with no models', () => {
    expect(pickStageModel([], 'anything')).toBeNull()
  })
})

describe('readableIfcType / humaniseIfcType', () => {
  it('drops the schema prefix and the modelling suffixes', () => {
    expect(readableIfcType('IfcWallStandardCase')).toBe('Wall')
    expect(readableIfcType('IfcSlabElementedCase')).toBe('Slab')
    expect(readableIfcType('IfcWindow')).toBe('Window')
  })

  it('splits CamelCase into words', () => {
    expect(humaniseIfcType('IfcCurtainWall')).toBe('Curtain Wall')
    expect(humaniseIfcType('IfcBuildingElementProxy')).toBe('Building Element Proxy')
  })

  it('leaves an acronym intact instead of spelling it out letter by letter', () => {
    expect(humaniseIfcType('IfcHVACDuct')).toBe('HVAC Duct')
  })
})

describe('formatLevelElevation', () => {
  it('signs the number, which is the only thing the list is scanned for', () => {
    expect(formatLevelElevation(3.2)).toBe('+3.20')
    expect(formatLevelElevation(-2.8)).toBe('−2.80')
  })

  it('marks ground level as the datum rather than as a bare zero', () => {
    expect(formatLevelElevation(0)).toBe('±0.00')
    // Rounding to centimetres lands exactly on the datum, and it should read
    // as the datum rather than as "+0.00", which looks like a rounding artefact.
    expect(formatLevelElevation(0.001)).toBe('±0.00')
  })

  it('rounds to centimetres — a millimetre in a level list is noise', () => {
    expect(formatLevelElevation(3.2049)).toBe('+3.20')
  })

  it('leaves the unit to the dictionary', () => {
    // A number formatted here and captioned there is how "+3.20 m" ends up in
    // an otherwise German rail.
    expect(formatLevelElevation(3.2)).not.toContain('m')
  })
})
