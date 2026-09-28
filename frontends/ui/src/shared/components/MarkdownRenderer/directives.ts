/**
 * The answer's directive dialect, parsed (`lib/text/answer-directives.ts` is
 * the vocabulary and the reason it exists).
 *
 * `remark-directive` reads every `:::name`, `::name` and `:name` in the text.
 * This plugin runs right after it and decides what each one becomes:
 *
 *  - a block of the dialect becomes an `answer-block` element carrying its
 *    name, which `directive-shape.ts` shapes and `directive-blocks.tsx` draws;
 *    its `[label]` (a `details` summary) becomes an `answer-block-label`;
 *  - a marker (`:current`, `:applies`, `:recommended`) becomes an empty
 *    `answer-marker`, read by the shaping pass and never drawn as text;
 *  - `:energy-class[B]` becomes an `answer-energy` element;
 *  - anything else is put back exactly as it was written. `remark-directive`
 *    also reads „10:30" and „Hinweis:Achtung" as directives, so an unknown
 *    inline or leaf directive is restored from the source text, and an unknown
 *    block keeps its content without its fences: nothing vanishes, and no
 *    `:::` reaches the page.
 *
 * The citation plugins run after this one, so a `[N]` inside a block, or in
 * text this plugin put back, is still a citation.
 */

import type { Properties } from 'hast'
import type { Data, Parent, Root, RootContent, Text } from 'mdast'
import type { ContainerDirective, LeafDirective, TextDirective } from 'mdast-util-directive'
import { ENERGY_CLASS_DIRECTIVE, energyClass, isDirectiveBlock, isDirectiveMarker } from '@/lib/text/answer-directives'

type Directive = ContainerDirective | LeafDirective | TextDirective

interface FileLike {
  value?: unknown
}

/** The custom element names the dialect becomes; never a tag Markdown itself produces. */
export const ANSWER_BLOCK_TAG = 'answer-block'
export const ANSWER_BLOCK_LABEL_TAG = 'answer-block-label'
export const ANSWER_MARKER_TAG = 'answer-marker'
export const ANSWER_ENERGY_TAG = 'answer-energy'

const isDirective = (node: RootContent): node is Directive =>
  node.type === 'containerDirective' || node.type === 'leafDirective' || node.type === 'textDirective'

/** The directive's own source text, or its label when the position is unknown. */
function sourceOf(node: Directive, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (source && start !== undefined && end !== undefined) return source.slice(start, end)
  const label = node.children.map((child) => ('value' in child ? String(child.value) : '')).join('')
  return `:${node.name}${label ? `[${label}]` : ''}`
}

const setElement = (node: { data?: Data }, tagName: string, properties: Properties) => {
  node.data = { ...node.data, hName: tagName, hProperties: properties }
}

/** What one directive node is replaced with, in its parent's children. */
function transform(node: Directive, source: string): RootContent[] {
  if (node.type === 'textDirective') {
    if (isDirectiveMarker(node.name) && node.children.length === 0) {
      setElement(node, ANSWER_MARKER_TAG, { dataMarker: node.name })
      return [node]
    }
    const label = node.children.map((child) => ('value' in child ? String(child.value) : '')).join('')
    const rating = node.name === ENERGY_CLASS_DIRECTIVE ? energyClass(label) : null
    if (rating) {
      setElement(node, ANSWER_ENERGY_TAG, { dataClass: rating })
      node.children = [{ type: 'text', value: rating }]
      return [node]
    }
    return [{ type: 'text', value: sourceOf(node, source) } satisfies Text]
  }
  if (node.type === 'leafDirective') {
    return [{ type: 'paragraph', children: [{ type: 'text', value: sourceOf(node, source) }] }]
  }
  if (!isDirectiveBlock(node.name)) {
    // Unknown block: its content, as if the fences were not there. The label
    // paragraph is content too.
    return node.children as RootContent[]
  }
  setElement(node, ANSWER_BLOCK_TAG, { dataBlock: node.name })
  const first = node.children[0]
  if (first && first.type === 'paragraph' && (first.data as { directiveLabel?: boolean } | undefined)?.directiveLabel) {
    setElement(first, ANSWER_BLOCK_LABEL_TAG, {})
  }
  return [node]
}

function visit(parent: Parent, source: string): void {
  const next: RootContent[] = []
  let changed = false
  for (const child of parent.children as RootContent[]) {
    if (isDirective(child)) {
      const replaced = transform(child, source)
      changed = true
      for (const node of replaced) {
        if ('children' in node) visit(node as Parent, source)
        next.push(node)
      }
      continue
    }
    if ('children' in child) visit(child as Parent, source)
    next.push(child)
  }
  if (changed) parent.children = mergeText(next) as Parent['children']
}

/** Adjacent text nodes joined, so a restored `:30` reads as one run with „10". */
function mergeText(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (node.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', value: last.value + node.value }
      continue
    }
    out.push(node)
  }
  return out
}

/** The remark plugin; run it right after `remark-directive`. */
export function remarkAnswerDirectives() {
  return (tree: Root, file: FileLike) => {
    visit(tree, typeof file.value === 'string' ? file.value : '')
  }
}
