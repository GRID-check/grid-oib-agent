/**
 * `diagrams` namespace — a diagram Piloti drew, in the answer and in the project.
 *
 * Two audiences share this namespace and they need different registers. The
 * reader of an answer gets one line and a button; the developer whose renderer
 * posted something the server refused gets a sentence naming what was wrong,
 * because that message is the only debugging surface a browser has.
 *
 * The `rejected.*` set is one member per `DIAGRAM_SVG_REJECTIONS` entry, and
 * `diagram-copy.spec.ts` fails when the tuple grows without the copy — a
 * refusal that renders as `undefined` is worse than one that renders in the
 * wrong language.
 */
export const diagrams = {
  /**
   * The line that carries the doctrine to the reader.
   *
   * Fifteen schematic cards in this product draw geometry the RENDERER computes,
   * so „a card cannot show a diagram that disagrees with its own numbers". A
   * diagram written as mermaid has no such guarantee — the model's text IS the
   * geometry. So the drawing says, in one line and everywhere it appears, that
   * it is not claiming a measurement.
   */
  schematicOnly: 'Schematic — no dimensions are claimed.',
  /** The file name a diagram gets when neither the source nor the surface names it. */
  defaultTitle: 'Diagram',
  fallback: 'This diagram could not be drawn. Its source is below.',
  file: {
    action: 'File in project',
    pending: 'Filing…',
    done: 'Filed in the project',
    open: 'Open in project',
    failed: 'Could not be filed',
    /** The SVG landed and the PDF did not. Naming both halves beats "done". */
    partial: 'The image was filed; the PDF was not. Try again to add it.',
  },
  /**
   * The provenance block printed in the PDF itself.
   *
   * The grey byline in the Files pane is chrome; this line is the artifact, and
   * the artifact is what reaches the Behörde — the same argument the `.docx`
   * export makes for its first-page block.
   */
  marking:
    'Created by Piloti — AI-generated, not reviewed. Schematic: no dimensions are claimed. Not a certificate; check every statement before passing this on.',
  rejected: {
    empty: 'The diagram was empty.',
    'too-large': 'The diagram is too large to file.',
    'malformed-xml': 'The diagram is not well-formed XML.',
    'doctype-or-entity': 'The diagram declares a document type or an entity, which is not allowed.',
    'not-svg': 'The file is not an SVG.',
    'missing-viewport': 'The diagram states no size, so it cannot be placed on a page.',
    'script-element': 'The diagram contains a script.',
    'foreign-object': 'The diagram embeds HTML (foreignObject). Render it with htmlLabels turned off.',
    'style-element':
      'The diagram carries a stylesheet. Flatten the styles onto the elements before filing it.',
    'unsupported-element': 'The diagram uses an element this product does not draw.',
    'event-handler-attribute': 'The diagram carries an event handler.',
    'external-reference': 'The diagram references something outside itself.',
    'source-too-large': 'The diagram source is too long.',
  },
}
