import { render, screen, fireEvent } from '@/test-utils'
import { describe, test, expect, vi } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'
import { InternalLinkProvider } from './internal-link-context'

describe('MarkdownRenderer', () => {
  describe('basic rendering', () => {
    test('renders plain text content', () => {
      render(<MarkdownRenderer content="Hello, world!" />)

      expect(screen.getByText('Hello, world!')).toBeInTheDocument()
    })

    test('renders empty content without error', () => {
      const { container } = render(<MarkdownRenderer content="" />)

      expect(container.querySelector('.markdown-content')).toBeInTheDocument()
    })

    test('applies custom className', () => {
      const { container } = render(
        <MarkdownRenderer content="Test" className="custom-class" />
      )

      expect(container.querySelector('.custom-class')).toBeInTheDocument()
    })
  })

  describe('headings', () => {
    test('renders h1 heading', () => {
      render(<MarkdownRenderer content="# Heading 1" />)

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Heading 1')
    })

    test('renders h2 heading', () => {
      render(<MarkdownRenderer content="## Heading 2" />)

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Heading 2')
    })

    test('renders h3 heading', () => {
      render(<MarkdownRenderer content="### Heading 3" />)

      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Heading 3')
    })

    test('renders h4 heading', () => {
      render(<MarkdownRenderer content="#### Heading 4" />)

      expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Heading 4')
    })

    test('headings have slugified id attributes for anchor navigation', () => {
      render(
        <MarkdownRenderer
          content={`# Introduction\n\n## Key Findings\n\n### Next Steps`}
        />
      )

      expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('id', 'introduction')
      expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('id', 'key-findings')
      expect(screen.getByRole('heading', { level: 3 })).toHaveAttribute('id', 'next-steps')
    })

    /*
      A report that assesses two variants writes „## Bewertung" twice. Both
      headings used to get `id="bewertung"`, so `getElementById` found the first
      and every link to the second — an outline row, an in-page citation anchor
      — scrolled to the wrong section without ever failing.
    */
    test('a repeated heading gets an id of its own', () => {
      const { container } = render(
        <MarkdownRenderer content={'## Bewertung\n\nText.\n\n## Bewertung\n\n## Bewertung'} />
      )

      const ids = Array.from(container.querySelectorAll('h2')).map((heading) => heading.id)
      expect(ids).toEqual(['bewertung', 'bewertung-2', 'bewertung-3'])
    })

    test('the first occurrence keeps the id it has always had', () => {
      // Links published against `#zusammenfassung` — stored citation anchors,
      // an address somebody pasted — must not move because a later section
      // repeats the title.
      const { container } = render(
        <MarkdownRenderer content={'## Zusammenfassung\n\n## Zusammenfassung'} />
      )

      expect(container.querySelector('h2')?.id).toBe('zusammenfassung')
    })

    test('two renderers on one page do not number each other', () => {
      // A chat thread mounts one of these per answer, and a module-level or
      // ref-held counter would carry the first document's tally into the
      // second: its lone „Bewertung" would come out as `bewertung-2`.
      const { container } = render(
        <>
          <MarkdownRenderer content={'## Bewertung\n\n## Bewertung'} />
          <MarkdownRenderer content={'## Bewertung'} />
        </>
      )

      const ids = Array.from(container.querySelectorAll('h2')).map((heading) => heading.id)
      expect(ids).toEqual(['bewertung', 'bewertung-2', 'bewertung'])
    })

    test('re-rendering the same document does not renumber it', () => {
      // The ids come from a pure pass over the markdown, not from counting the
      // callbacks as they fire, so a second render — which React may perform
      // whenever it likes — cannot move an anchor.
      const { container, rerender } = render(
        <MarkdownRenderer content={'## Bewertung\n\n## Bewertung'} />
      )
      rerender(<MarkdownRenderer content={'## Bewertung\n\n## Bewertung'} className="x" />)

      const ids = Array.from(container.querySelectorAll('h2')).map((heading) => heading.id)
      expect(ids).toEqual(['bewertung', 'bewertung-2'])
    })

    test('a heading inside fenced code is sample text and takes no id', () => {
      const { container } = render(
        <MarkdownRenderer
          content={'## Bewertung\n\n```markdown\n## Bewertung\n```\n\n## Bewertung'}
        />
      )

      const ids = Array.from(container.querySelectorAll('h2')).map((heading) => heading.id)
      expect(ids).toEqual(['bewertung', 'bewertung-2'])
    })

    test('the anchor scroll target of a repeated heading is the second one', () => {
      const scrollIntoView = vi.fn()
      const { container } = render(
        <MarkdownRenderer content={'## Bewertung\n\n## Bewertung\n\n[Zur zweiten](#bewertung-2)'} />
      )
      const second = container.querySelectorAll('h2')[1]
      second.scrollIntoView = scrollIntoView

      fireEvent.click(screen.getByRole('link', { name: 'Zur zweiten' }))

      expect(scrollIntoView).toHaveBeenCalled()
    })
  })

  describe('paragraphs', () => {
    test('renders paragraph text', () => {
      render(<MarkdownRenderer content="This is a paragraph." />)

      expect(screen.getByText('This is a paragraph.')).toBeInTheDocument()
    })

    test('renders multiple paragraphs', () => {
      render(<MarkdownRenderer content={`Paragraph 1.

Paragraph 2.`} />)

      expect(screen.getByText('Paragraph 1.')).toBeInTheDocument()
      expect(screen.getByText('Paragraph 2.')).toBeInTheDocument()
    })
  })

  describe('lists', () => {
    test('renders unordered list', () => {
      render(<MarkdownRenderer content={`- Item 1
- Item 2
- Item 3`} />)

      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 2')).toBeInTheDocument()
      expect(screen.getByText('Item 3')).toBeInTheDocument()
    })

    test('renders ordered list', () => {
      render(<MarkdownRenderer content={`1. First
2. Second
3. Third`} />)

      expect(screen.getByText('First')).toBeInTheDocument()
      expect(screen.getByText('Second')).toBeInTheDocument()
      expect(screen.getByText('Third')).toBeInTheDocument()
    })
  })

  describe('inline formatting', () => {
    test('renders bold text', () => {
      render(<MarkdownRenderer content="This is **bold** text." />)

      expect(screen.getByText('bold')).toHaveClass('font-semibold')
    })

    test('renders italic text', () => {
      render(<MarkdownRenderer content="This is *italic* text." />)

      const italicElement = screen.getByText('italic')
      expect(italicElement.tagName).toBe('EM')
    })

    test('renders inline code', () => {
      render(<MarkdownRenderer content="Use the `console.log()` function." />)

      const codeElement = screen.getByText('console.log()')
      expect(codeElement.tagName).toBe('CODE')
      expect(codeElement).toHaveClass('font-mono')
    })
  })

  describe('links', () => {
    test('renders links with correct href', () => {
      render(<MarkdownRenderer content="Visit [Example](https://example.com)" />)

      const link = screen.getByRole('link', { name: 'Example' })
      expect(link).toHaveAttribute('href', 'https://example.com')
    })

    test('external links open in new tab', () => {
      render(<MarkdownRenderer content="[Link](https://example.com)" />)

      const link = screen.getByRole('link', { name: 'Link' })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    test('anchor links do not open in new tab', () => {
      render(<MarkdownRenderer content="[Introduction](#introduction)" />)

      const link = screen.getByRole('link', { name: 'Introduction' })
      expect(link).toHaveAttribute('href', '#introduction')
      expect(link).not.toHaveAttribute('target', '_blank')
    })

    test('anchor links scroll to the target heading', () => {
      const scrollMock = vi.fn()
      vi.spyOn(document, 'getElementById').mockReturnValue({
        scrollIntoView: scrollMock,
      } as unknown as HTMLElement)

      render(
        <MarkdownRenderer
          content={`[Go to section](#my-section)\n\n## My Section\n\nContent here.`}
        />
      )

      const link = screen.getByRole('link', { name: 'Go to section' })
      fireEvent.click(link)

      expect(document.getElementById).toHaveBeenCalledWith('my-section')
      expect(scrollMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })

      vi.restoreAllMocks()
    })

    /*
      German headings are the normal case here, not an edge case: the answers and
      OIB reports this renders are written in German. Stripping the umlaut
      outright ("Gebäude" → "gebude") produced an id nothing links to, so every
      in-page link into such a section silently did nothing — `scrollToAnchor`
      returns quietly when `getElementById` misses.
    */
    test('gives a German heading an id that survives its umlauts', () => {
      render(<MarkdownRenderer content={'## Brandschutz für Gebäude'} />)

      expect(screen.getByRole('heading', { name: 'Brandschutz für Gebäude' })).toHaveAttribute(
        'id',
        'brandschutz-fuer-gebaeude'
      )
    })

    test('gives a heading with ß an id that survives it', () => {
      render(<MarkdownRenderer content={'## Außenwand'} />)

      expect(screen.getByRole('heading', { name: 'Außenwand' })).toHaveAttribute(
        'id',
        'aussenwand'
      )
    })

    /*
      An in-app link is not an external one. Answers now write links back into
      the app — `/app/projects/:id/model?element=…` opens a wall in the viewer —
      and a new tab there means leaving the app to re-enter it with a cold store.
    */
    test('in-app links stay in the same tab', () => {
      render(<MarkdownRenderer content="[AW 38](/app/projects/p1/model?element=abc)" />)

      const link = screen.getByRole('link', { name: 'AW 38' })
      expect(link).toHaveAttribute('href', '/app/projects/p1/model?element=abc')
      expect(link).not.toHaveAttribute('target')
    })

    test('a protocol-relative href is external, however much it looks internal', () => {
      // `//evil.example/app` is another origin. This renders model output, so
      // the near-miss is the case that matters.
      render(<MarkdownRenderer content="[Link](//evil.example/app/projects/p1/model)" />)

      const link = screen.getByRole('link', { name: 'Link' })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    test('a surface that knows the destination renders it itself', () => {
      render(
        <InternalLinkProvider
          render={({ href, children }) => <span data-testid="custom">{`${children}@${href}`}</span>}
        >
          <MarkdownRenderer content="[AW 38](/app/projects/p1/model?element=abc)" />
        </InternalLinkProvider>
      )

      expect(screen.getByTestId('custom')).toHaveTextContent(
        'AW 38@/app/projects/p1/model?element=abc'
      )
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })

    test('leaves ASCII heading ids exactly as they were', () => {
      // The transliteration must not disturb the ids already in use — including
      // the punctuation-stripping shape (`1.2` → `12`, not `1-2`).
      render(<MarkdownRenderer content={'## Section 1.2 Overview'} />)

      expect(screen.getByRole('heading', { name: 'Section 1.2 Overview' })).toHaveAttribute(
        'id',
        'section-12-overview'
      )
    })
  })

  describe('code blocks', () => {
    test('renders code block with language', () => {
      const code = '```javascript\nconst x = 1;\n```'

      render(<MarkdownRenderer content={code} />)

      // CodeSnippet component should be rendered
      expect(screen.getByText('const x = 1;')).toBeInTheDocument()
    })

    test('renders code block without language', () => {
      const code = '```\nplain code\n```'

      render(<MarkdownRenderer content={code} />)

      expect(screen.getByText('plain code')).toBeInTheDocument()
    })

    test('renders Python code block', () => {
      const code = '```python\ndef hello():\n    print("Hello")\n```'

      render(<MarkdownRenderer content={code} />)

      expect(screen.getByText(/def hello/)).toBeInTheDocument()
    })
  })

  describe('blockquotes', () => {
    test('renders blockquote', () => {
      render(<MarkdownRenderer content="> This is a quote" />)

      const blockquote = screen.getByText('This is a quote').closest('blockquote')
      expect(blockquote).toBeInTheDocument()
    })
  })

  describe('horizontal rules', () => {
    test('renders horizontal rule', () => {
      const { container } = render(<MarkdownRenderer content={`Above

---

Below`} />)

      expect(container.querySelector('hr')).toBeInTheDocument()
    })
  })

  describe('tables (GFM)', () => {
    test('renders table with headers', () => {
      const tableMarkdown = `
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`
      render(<MarkdownRenderer content={tableMarkdown} />)

      expect(screen.getByText('Header 1')).toBeInTheDocument()
      expect(screen.getByText('Header 2')).toBeInTheDocument()
      expect(screen.getByText('Cell 1')).toBeInTheDocument()
      expect(screen.getByText('Cell 4')).toBeInTheDocument()
    })
  })

  describe('math (KaTeX)', () => {
    test('renders inline math instead of leaving raw $ delimiters', () => {
      const { container } = render(
        <MarkdownRenderer content={'The resistance is $R = \\rho \\frac{L}{A}$ overall.'} />
      )

      // rehype-katex emits a .katex wrapper for typeset math.
      expect(container.querySelector('.katex')).toBeInTheDocument()
      // The raw TeX source with dollar delimiters must not survive as text.
      expect(container.textContent).not.toContain('$R = \\rho')
    })

    test('renders fenced display math ($$ on their own lines) as a centered block', () => {
      const { container } = render(
        <MarkdownRenderer
          content={'Result:\n\n$$\nq_{\\mathrm{f}} = \\frac{\\sum M_i H_i}{A}\n$$\n\nDone.'}
        />
      )

      expect(container.querySelector('.katex-display')).toBeInTheDocument()
    })

    test('leaves a lone dollar sign in prose untouched', () => {
      render(<MarkdownRenderer content="The permit fee was 5 dollars, not $." />)

      expect(screen.getByText(/The permit fee was 5 dollars/)).toBeInTheDocument()
    })

    test('does not crash on malformed TeX (throwOnError: false)', () => {
      const { container } = render(<MarkdownRenderer content={'Broken: $\\frac{1}$ here.'} />)

      // Renders something rather than throwing; container is present.
      expect(container.querySelector('.markdown-content')).toBeInTheDocument()
    })
  })

  describe('compact mode', () => {
    test('uses default text size when compact is false', () => {
      render(<MarkdownRenderer content="Normal text" compact={false} />)

      // Text should be rendered (we can't easily check the exact kind prop)
      expect(screen.getByText('Normal text')).toBeInTheDocument()
    })

    test('uses smaller text size when compact is true', () => {
      render(<MarkdownRenderer content="Compact text" compact={true} />)

      // Text should be rendered
      expect(screen.getByText('Compact text')).toBeInTheDocument()
    })
  })

  describe('complex content', () => {
    test('renders mixed content correctly', () => {
      const content = `
# Main Title

This is a paragraph with **bold** and *italic* text.

## Code Example

\`\`\`javascript
const greeting = "Hello";
\`\`\`

### List of Items

- Item one
- Item two
- Item three

> A thoughtful quote

Visit [our site](https://example.com) for more.
`
      render(<MarkdownRenderer content={content} />)

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Main Title')
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Code Example')
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('List of Items')
      expect(screen.getByText('bold')).toBeInTheDocument()
      expect(screen.getByText('Item one')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'our site' })).toBeInTheDocument()
    })
  })

  describe('memoization', () => {
    test('component has displayName set', () => {
      expect(MarkdownRenderer.displayName).toBe('MarkdownRenderer')
    })
  })

  describe('edge cases', () => {
    test('handles special characters', () => {
      render(<MarkdownRenderer content={'Special chars: < > & " \''} />)

      expect(screen.getByText(/Special chars/)).toBeInTheDocument()
    })

    test('handles very long content', () => {
      const longContent = 'Word '.repeat(1000)

      const { container } = render(<MarkdownRenderer content={longContent} />)

      expect(container.querySelector('.markdown-content')).toBeInTheDocument()
    })

    test('handles nested formatting', () => {
      render(<MarkdownRenderer content="**Bold with *italic* inside**" />)

      // Should render without errors
      expect(screen.getByText(/Bold with/)).toBeInTheDocument()
    })
  })

  describe('the streaming stabilizer is linear in the length of a line', () => {
    /**
     * The delimiter-row test used to read `/^\s*\|?\s*:?-{1,}/`, putting two
     * `\s*` either side of an optional pipe. On a line of pure whitespace the
     * engine can split that whitespace between them in quadratically many ways:
     * 32k tabs took 1,034ms. This runs on every token of every streaming answer,
     * and the answer's text comes from a model writing over retrieved documents,
     * so the length of a line is not ours to bound.
     *
     * An absolute budget, not a ratio: healthy timings here are microseconds and
     * a ratio between two of those is noise. 400ms sits well below the defect
     * and four orders of magnitude above healthy.
     */
    test('a long run of whitespace under a table does not stall the render', () => {
      const content = `| Bauteil | REI |\n|${'\t'.repeat(32_000)}\n`

      const started = performance.now()
      render(<MarkdownRenderer content={content} isStreaming />)
      const elapsed = performance.now() - started

      expect(elapsed).toBeLessThan(400)
    })

    test('a real delimiter row is still recognised, so the table is not escaped', () => {
      const { container } = render(
        <MarkdownRenderer content={'| Bauteil | REI |\n| :--- | ---: |\n| Wand | 90 |'} isStreaming />
      )

      expect(container.querySelector('table')).not.toBeNull()
    })
  })
})
