/**
 * The in-answer card ground — the framed register, understated.
 *
 * "Cards" is the vocabulary of the schema, not of the pixels: the product
 * owner's brief moved from "each card unique and stunning" to "a card should
 * read as part of the answer, never as its own object" (grid-card-charter.md
 * records both). So the framed register stopped being a bordered, shadowed box
 * and became a QUIET GROUND: a soft `bg-muted` tint, no border, no shadow. An
 * exhibit then sits in the answer the way a figure sits in a book — grouped by
 * its ground and its typography, not fenced off from the prose around it.
 *
 * `border-transparent` rather than `border-none`, deliberately: the `Card`
 * atom draws a 1px border, and keeping its width (invisible) means nothing
 * shifts by a pixel — while the accented cards' `border-l-*` colour utilities
 * still take effect on top of it. Order matters for that: pass this constant
 * FIRST into `cn(...)` so a side-specific accent colour wins the merge.
 *
 * One constant, imported by every framed card site (`SchematicCard`, the
 * direct `Card` usages, `ProposalShell`), so "how quiet is a card" is decided
 * exactly once.
 */
export const CARD_SHELL = 'border-transparent bg-muted/40 shadow-none'

/**
 * The opened disclosure inside a card's expandable list — the legal form of
 * "no card inside a card" (charter §A4): a dashed outline on a muted ground,
 * on the same surface.
 *
 * Positional offsets stay with the caller: list rows that hang off a rail
 * grid (`deadline_timeline`, `condition_tree`, `process_map`) use this as-is,
 * while rows carrying their own icon column (`change_impact`,
 * `document_checklist`) add `ml-6` to sit under the row's text. The tinted
 * ACTIVE branch panels in `condition_tree` / `process_map` are deliberately
 * NOT this — their chrome differs in kind (solid tinted vs dashed muted), and
 * collapsing that distinction would lose the marking the screenshot-safety of
 * those cards rests on.
 *
 * PascalCase by intent: this is the disclosure *panel* primitive, named for
 * what it is rather than for the constant convention around it.
 */
export const CardDisclosurePanel =
  'mt-1.5 flex flex-col gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2.5'

/**
 * The law-citation notice row inside an opened disclosure — the branch-scale
 * echo of `NormRefFooter` (Scale glyph + document + § + edition) on the
 * source-law tint.
 *
 * Surface only, no layout: the four single-row sites compose it with
 * `flex flex-wrap items-center gap-x-2 gap-y-1`, while `condition_tree`'s
 * branch reference (which also carries an excerpt blockquote) composes it
 * with `flex flex-col gap-1.5`. One material, two stackings — the tint stays
 * identical either way.
 */
export const CARD_NOTICE_LAW = 'rounded-md bg-source-law-tint px-3 py-2 text-xs text-source-law-text'
