/**
 * @vitest-environment node
 */

/**
 * The guard that the TypeScript union knows every card type the catalog has.
 *
 * `shared/cards/schemas.json` is generated from `models.py`; `generated.ts` is
 * generated from `schemas.json`; and `test_schema_sync.py` holds the FIRST of
 * those two arrows. Nothing held the second. So the whole cross-stack chain
 * could be green with the frontend union one card type short — which is not a
 * hypothetical: `diagram` was added to the Python union and the catalog the
 * model reads while the generated Zod on this side still had no such member.
 *
 * What that costs is out of all proportion to "one card does not draw", and
 * `validate-grid-cards.spec.ts` pins the mechanism: `validateGridCards` DROPS
 * an unrecognised card and RENUMBERS what is left, while the answer's
 * `[[card:N]]` markers index into exactly that filtered array. One unknown type
 * therefore does not leave a gap — it shifts every card after it up by one, so
 * the marker the model wrote for its Frist draws a summary instead, in cards
 * whose own types shipped and work. Silent, and wrong in a compliance answer.
 *
 * The two assertions below are deliberately about MEMBERSHIP and nothing else,
 * because membership is what fails in the way described above and because a
 * missing type has to be nameable in the failure message. The stronger check —
 * that the committed module is byte-for-byte what the generator produces from
 * the same input, so a type present on both sides cannot have diverged FIELDS —
 * lives in `scripts/generate-card-schemas.spec.mjs`, next to the generator it
 * is a claim about.
 *
 * Why here and not in the backend suite: this reads the real Zod union rather
 * than a regex over its source, which is the only reading that cannot be fooled
 * by a member that is declared and then not put in the union. The backend suite
 * keeps its own cheap mirror (`test_interactive_card_parity.py`) so an author
 * who adds a card type there still sees the obligation without running vitest.
 */

import { describe, expect, it } from 'vitest'
import { gridCardSchema } from './schemas'
// The canonical card JSON Schema, generated from `models.py` and the input the
// Zod mirror is generated FROM. Reached by path because it lives above the app
// root; `scripts/generate-card-schemas.mjs` reads the same file the same way.
import cardJsonSchema from '../../../../../shared/cards/schemas.json'

interface JsonSchemaDocument {
  discriminator: { propertyName: string; mapping: Record<string, string> }
  oneOf: Array<{ $ref: string }>
}

const document = cardJsonSchema as unknown as JsonSchemaDocument

/**
 * Every card type the canonical schema declares.
 *
 * Read off `discriminator.mapping` rather than by walking `oneOf` into each
 * def's `type` const: the mapping is what Pydantic itself says the tagged union
 * dispatches on, so it is the same list the backend validates against, and
 * reading it needs no second opinion about where a discriminator lives.
 */
const CATALOG_TYPES = Object.keys(document.discriminator.mapping).sort()

/** Every card type the frontend union will actually parse. */
const UNION_TYPES = [...gridCardSchema.optionsMap.keys()]
  .filter((type): type is string => typeof type === 'string')
  .sort()

const REGENERATE =
  'Run `uv run python scripts/generate_card_schema.py` (repo root) and then ' +
  '`npm run generate:cards` (frontends/ui), and commit both results.'

describe('the card union covers the canonical catalog', () => {
  it('has a discriminator mapping that names every member of the union', () => {
    // Without this the two assertions below could both pass against a mapping
    // that had quietly stopped listing most of the catalog.
    expect(CATALOG_TYPES).toHaveLength(document.oneOf.length)
    // A floor well under the real count, not near it: this assertion is here
    // to catch a mapping that has gone empty or tiny, and one pinned to today's
    // number would fire on the legitimate retirement of a single card type —
    // the case the assertion below is supposed to report in its own words.
    expect(CATALOG_TYPES.length).toBeGreaterThan(30)
  })

  it('parses every card type shared/cards/schemas.json declares', () => {
    const missing = CATALOG_TYPES.filter((type) => !UNION_TYPES.includes(type))
    expect(
      missing,
      `src/shared/cards/generated.ts has no union member for card type(s) ${JSON.stringify(missing)}, ` +
        'which shared/cards/schemas.json declares. `validateGridCards` drops a card it cannot ' +
        'parse AND renumbers the rest, so every [[card:N]] marker after one of these draws the ' +
        `wrong card instead of nothing. The union is generated, so do not hand-edit it: ${REGENERATE}`
    ).toEqual([])
  })

  it('parses no card type the canonical catalog has dropped', () => {
    // The other direction, and a real state rather than a tidy symmetry: a card
    // type retired in `models.py` leaves a union member that accepts something
    // the backend will never send and that no renderer branch has to exist for
    // (`test_renderer_branches_are_real_card_types` only reads GridCards.tsx).
    const orphaned = UNION_TYPES.filter((type) => !CATALOG_TYPES.includes(type))
    expect(
      orphaned,
      `src/shared/cards/generated.ts still parses card type(s) ${JSON.stringify(orphaned)}, which ` +
        `shared/cards/schemas.json no longer declares. ${REGENERATE}`
    ).toEqual([])
  })
})
