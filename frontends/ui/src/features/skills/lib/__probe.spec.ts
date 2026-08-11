import { describe, expect, test } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'

describe('probe', () => {
  test('options', () => {
    const opts = (gridCardSchema as any).options
    console.log('n=', opts.length)
    for (const o of opts) {
      let t = o.shape.type
      while (t._def?.innerType) t = t._def.innerType
      console.log(t._def.value, '|', o.description)
    }
  })
})
