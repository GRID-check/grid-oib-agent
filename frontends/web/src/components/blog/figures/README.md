# Blog figures

Technical drawings for blog posts, in the house style: blueprint paper,
olive strokes, IBM Plex Mono labels. The look is defined once, in
`FigureFrame.astro`; every figure is inline SVG composed from its classes, so a
new figure picks up the brand by construction.

## Using a figure in a post

Blog entries are MDX, so a post imports the component and passes its labels:

```mdx
import IsoStackFigure from '../../../components/blog/figures/IsoStackFigure.astro'

<IsoStackFigure
  kicker="FIG. 01"
  alt="Six layers of the answer pipeline as an exploded stack"
  layers={[{ label: 'SOURCES', sublabel: 'BAURECHT - BUERO - PROJEKT - WEB', glyph: 'tiles' }]}
/>
```

Labels are props, never hardcoded, because every post exists in `de` and `en`
and both locales share one drawing. Write labels in uppercase yourself; SVG
text does not reliably obey `text-transform`.

## Adding a new figure

1. Create `YourFigure.astro` here. Wrap the SVG in `<FigureFrame>` and give it
   a real `alt`; the frame renders kicker, caption, and the paper background.
2. Draw with the shared classes only: `fp-stroke`, `fp-stroke--muted`,
   `fp-dash`, `fp-fill`, `fp-fill--soft`, `fp-fill--tint`, `fp-label`,
   `fp-label--muted`, `fp-label--accent`. If a figure needs a new color, add a
   class in `FigureFrame.astro` so the next figure has it too.
3. Take label text as props. Compute geometry in frontmatter (see
   `IsoStackFigure.astro`) instead of hand-placing forty coordinates.
4. Arrowheads: define a `<marker>` per SVG with a figure-specific id; ids are
   global per page and two figures on one post must not collide.

`IsoStackFigure` is the generic one: any layered system, one `layers` array.
The others (`ScopeFigure`, `HybridFigure`, `LessonLoopFigure`) are bespoke
drawings for specific posts and templates for the next bespoke one.
