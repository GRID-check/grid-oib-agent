# Grid OIB Agent MVP — Phase 3: Frontend Reskin + Response Cards

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Implement tasks in order, run verification commands, and commit.

**Goal:** Remove NVIDIA branding, apply a clean Grid theme, parse the `<grid_cards>` JSON block from agent responses, and render the two POC card components.

**Architecture:**
- Global theme tokens are moved to CSS variables in `frontends/ui/src/app/globals.css` and used by Tailwind classes.
- `frontends/ui/src/features/chat/components/AgentResponse.tsx` is extended to parse cards from the response content, remove the JSON block from the displayed markdown, and render a `<GridCardsRenderer />`.
- `frontends/ui/src/features/chat/components/cards/` contains `SummaryCard.tsx`, `LegalBasisCard.tsx`, and a small `parseGridCards.ts` utility.
- `frontends/ui/src/features/chat/types.ts` gets a `GridCard` union type.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Radix UI primitives via `@/adapters/ui`.

---

## File inventory

All paths are relative to `frontends/ui/src` unless noted.

---

### Task 1: Remove NVIDIA branding from layout and metadata

**Files:**
- Modify: `frontends/ui/src/app/layout.tsx`
- Modify: `frontends/ui/src/app/page.tsx`
- Modify: `frontends/ui/package.json` (optional: update metadata name)
- Replace/delete: `frontends/ui/public/favicon.ico` (if NVIDIA logo) — replace with a simple Grid favicon or remove if Next.js generates one.

- [ ] **Step 1: Update `frontends/ui/src/app/layout.tsx`**

Change the `<title>` and `<meta name="description">` to:

```tsx
export const metadata = {
  title: 'Grid OIB Research Agent',
  description: 'AI research assistant for Austrian OIB Richtlinien and building regulations.',
}
```

Remove any NVIDIA-specific comments or Open Graph tags referencing NVIDIA.

- [ ] **Step 2: Update `frontends/ui/src/app/page.tsx`**

Remove or replace any NVIDIA header/hero text in the main page. If there is a landing headline, set it to:

```tsx
<h1 className="text-2xl font-semibold text-foreground">Grid OIB Research Agent</h1>
```

- [ ] **Step 3: Stage and commit**

```bash
git add frontends/ui/src/app/layout.tsx frontends/ui/src/app/page.tsx
[ -f frontends/ui/public/favicon.ico ] && git add frontends/ui/public/favicon.ico
git commit -s -m "feat(ui): rebrand page metadata and titles"
```

---

### Task 2: Replace Logo component

**Files:**
- Modify: `frontends/ui/src/features/layout/components/Logo.tsx` (or wherever the logo is defined)

- [ ] **Step 1: Inspect the Logo file location**

```bash
find frontends/ui/src -name "Logo.tsx" -o -name "NvidiaLogo*" -o -name "*logo*"
```

- [ ] **Step 2: Replace the Logo component with a text/wordmark logo**

Example for `frontends/ui/src/features/layout/components/Logo.tsx`:

```tsx
'use client'

import Link from 'next/link'

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-foreground font-bold">
        G
      </span>
      <span className="text-lg font-semibold tracking-tight">Grid</span>
    </Link>
  )
}
```

If the file exports a different name, adjust imports accordingly.

- [ ] **Step 3: Stage and commit**

```bash
git add frontends/ui/src/features/layout/components/Logo.tsx
git commit -s -m "feat(ui): replace NVIDIA logo with Grid wordmark"
```

---

### Task 3: Add Grid theme tokens

**Files:**
- Modify: `frontends/ui/src/app/globals.css`
- Modify: `frontends/ui/tailwind.config.ts` or equivalent (if present)

- [ ] **Step 1: Inspect Tailwind setup**

```bash
ls frontends/ui/tailwind.config.* frontends/ui/postcss.config.*
```

- [ ] **Step 2: Update `frontends/ui/src/app/globals.css`**

Replace any NVIDIA color variable blocks with:

```css
@layer base {
  :root {
    /* Grid brand palette */
    --brand: 220 80% 50%;        /* deep blue */
    --brand-foreground: 0 0% 100%;

    --background: 0 0% 98%;
    --foreground: 220 20% 18%;
    --card: 0 0% 100%;
    --card-foreground: 220 20% 18%;
    --popover: 0 0% 100%;
    --popover-foreground: 220 20% 18%;
    --primary: 220 80% 50%;
    --primary-foreground: 0 0% 100%;
    --secondary: 220 14% 92%;
    --secondary-foreground: 220 20% 18%;
    --muted: 220 14% 95%;
    --muted-foreground: 220 10% 45%;
    --accent: 36 90% 52%;        /* warm accent */
    --accent-foreground: 220 20% 10%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 100%;
    --border: 220 13% 88%;
    --input: 220 13% 88%;
    --ring: 220 80% 50%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 220 20% 10%;
    --foreground: 0 0% 95%;
    --card: 220 18% 13%;
    --card-foreground: 0 0% 95%;
    --popover: 220 18% 13%;
    --popover-foreground: 0 0% 95%;
    --primary: 217 91% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 220 15% 22%;
    --secondary-foreground: 0 0% 95%;
    --muted: 220 15% 18%;
    --muted-foreground: 220 10% 60%;
    --accent: 36 90% 52%;
    --accent-foreground: 220 20% 10%;
    --destructive: 0 62% 50%;
    --destructive-foreground: 0 0% 100%;
    --border: 220 15% 24%;
    --input: 220 15% 24%;
    --ring: 217 91% 60%;
  }
}
```

Keep non-color rules (e.g., `@import "tailwindcss"` if Tailwind v4) intact.

- [ ] **Step 3: If using Tailwind v3 config, add a brand color extension**

In `tailwind.config.ts`:

```ts
colors: {
  brand: {
    DEFAULT: 'hsl(var(--brand))',
    foreground: 'hsl(var(--brand-foreground))',
  },
}
```

If using Tailwind v4 with CSS-only config, ensure `bg-brand` and `text-brand-foreground` classes resolve via the variables above.

- [ ] **Step 4: Stage and commit**

```bash
git add frontends/ui/src/app/globals.css
git add frontends/ui/tailwind.config.*
git commit -s -m "feat(ui): add Grid color theme tokens"
```

---

### Task 4: Add Grid card types

**Files:**
- Modify: `frontends/ui/src/features/chat/types.ts`

- [ ] **Step 1: Append card types at the end of `types.ts`**

```ts
// Grid response cards --------------------------------------------------------

export interface SummaryCardData {
  type: 'summary'
  title: string
  content: string
}

export interface LegalBasisCardData {
  type: 'legal_basis'
  title: string
  norm: string
  reference?: string
  summary?: string
}

export type GridCard = SummaryCardData | LegalBasisCardData
```

- [ ] **Step 2: Add a `cards` field to `ChatMessage`**

Inside `ChatMessage`, add:

```ts
/** Parsed Grid response cards (if any) */
cards?: GridCard[]
```

- [ ] **Step 3: Stage and commit**

```bash
git add frontends/ui/src/features/chat/types.ts
git commit -s -m "feat(ui): add Grid card types"
```

---

### Task 5: Create card parser utility

**Files:**
- Create: `frontends/ui/src/features/chat/utils/parseGridCards.ts`
- Create: `frontends/ui/src/features/chat/utils/__tests__/parseGridCards.test.ts` (or `frontends/ui/src/features/chat/utils/parseGridCards.test.ts`)

- [ ] **Step 1: Write the parser**

```ts
import type { GridCard } from '../types'

const GRID_CARDS_RE = /<grid_cards>([\s\S]*?)<\/grid_cards>/

export interface ParsedGridCards {
  text: string
  cards: GridCard[]
}

export function parseGridCards(content: string): ParsedGridCards {
  const match = content.match(GRID_CARDS_RE)
  if (!match) {
    return { text: content, cards: [] }
  }

  const rawJson = match[1].trim()
  let cards: GridCard[] = []
  try {
    cards = JSON.parse(rawJson)
    if (!Array.isArray(cards)) {
      cards = []
    }
  } catch {
    // If JSON is malformed, leave the block in the text.
    return { text: content, cards: [] }
  }

  const text = content.replace(match[0], '').trim()
  return { text, cards }
}
```

- [ ] **Step 2: Write the test**

```ts
import { parseGridCards } from './parseGridCards'

describe('parseGridCards', () => {
  it('returns the original text and no cards when no block is present', () => {
    const input = 'Just plain text.'
    const result = parseGridCards(input)
    expect(result.text).toBe(input)
    expect(result.cards).toEqual([])
  })

  it('parses a summary and legal_basis card', () => {
    const input = `
Some prose before.

<grid_cards>
[
  { "type": "summary", "title": "Zusammenfassung", "content": "OIB 6 regelt Wärmeschutz." },
  { "type": "legal_basis", "title": "Rechtsgrundlage", "norm": "OIB RL 6", "summary": "Wärmeschutz" }
]
</grid_cards>
`
    const result = parseGridCards(input)
    expect(result.cards).toHaveLength(2)
    expect(result.cards[0].type).toBe('summary')
    expect(result.cards[1].type).toBe('legal_basis')
    expect(result.text).not.toContain('<grid_cards>')
  })

  it('keeps malformed JSON in the text', () => {
    const input = 'Text \u003cgrid_cards\u003e not json \u003c/grid_cards\u003e'
    const result = parseGridCards(input)
    expect(result.cards).toEqual([])
    expect(result.text).toBe(input)
  })
})
```

- [ ] **Step 3: Run the test**

```bash
cd frontends/ui
npm test -- parseGridCards.test.ts
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add frontends/ui/src/features/chat/utils/parseGridCards.ts frontends/ui/src/features/chat/utils/parseGridCards.test.ts
git commit -s -m "feat(ui): add Grid card parser and tests"
```

---

### Task 6: Create card components

**Files:**
- Create: `frontends/ui/src/features/chat/components/cards/SummaryCard.tsx`
- Create: `frontends/ui/src/features/chat/components/cards/LegalBasisCard.tsx`
- Create: `frontends/ui/src/features/chat/components/cards/index.ts`

- [ ] **Step 1: Write `SummaryCard.tsx`**

```tsx
'use client'

import type { FC } from 'react'
import { Card, Flex, Text } from '@/adapters/ui'
import type { SummaryCardData } from '../../types'

export interface SummaryCardProps {
  card: SummaryCardData
}

export const SummaryCard: FC<SummaryCardProps> = ({ card }) => {
  return (
    <Card className="border-l-4 border-l-brand bg-card p-4 shadow-sm">
      <Flex direction="col" gap="2">
        <Text kind="label/regular/sm" className="text-muted-foreground uppercase tracking-wide">
          {card.title}
        </Text>
        <Text kind="body/regular/base" className="text-card-foreground">
          {card.content}
        </Text>
      </Flex>
    </Card>
  )
}
```

- [ ] **Step 2: Write `LegalBasisCard.tsx`**

```tsx
'use client'

import type { FC } from 'react'
import { Card, Flex, Text } from '@/adapters/ui'
import type { LegalBasisCardData } from '../../types'

export interface LegalBasisCardProps {
  card: LegalBasisCardData
}

export const LegalBasisCard: FC<LegalBasisCardProps> = ({ card }) => {
  return (
    <Card className="border-l-4 border-l-accent bg-card p-4 shadow-sm">
      <Flex direction="col" gap="2">
        <Text kind="label/regular/sm" className="text-muted-foreground uppercase tracking-wide">
          {card.title}
        </Text>
        <Text kind="body/medium/base" className="text-card-foreground">
          {card.norm}
        </Text>
        {card.summary && (
          <Text kind="body/regular/sm" className="text-muted-foreground">
            {card.summary}
          </Text>
        )}
        {card.reference && (
          <a
            href={card.reference}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand hover:underline text-sm"
          >
            {card.reference}
          </a>
        )}
      </Flex>
    </Card>
  )
}
```

- [ ] **Step 3: Write `index.ts`**

```ts
export { SummaryCard } from './SummaryCard'
export { LegalBasisCard } from './LegalBasisCard'
```

- [ ] **Step 4: Commit**

```bash
git add frontends/ui/src/features/chat/components/cards
git commit -s -m "feat(ui): add Summary and LegalBasis card components"
```

---

### Task 7: Render cards inside `AgentResponse`

**Files:**
- Modify: `frontends/ui/src/features/chat/components/AgentResponse.tsx`
- Create: `frontends/ui/src/features/chat/components/GridCards.tsx`

- [ ] **Step 1: Create `GridCards.tsx` dispatcher**

```tsx
'use client'

import type { FC } from 'react'
import { Flex } from '@/adapters/ui'
import { SummaryCard } from './cards/SummaryCard'
import { LegalBasisCard } from './cards/LegalBasisCard'
import type { GridCard } from '../types'

export interface GridCardsProps {
  cards: GridCard[]
}

export const GridCards: FC<GridCardsProps> = ({ cards }) => {
  if (!cards.length) return null

  return (
    <Flex direction="col" gap="3" className="w-full">
      {cards.map((card, index) => {
        switch (card.type) {
          case 'summary':
            return <SummaryCard key={index} card={card} />
          case 'legal_basis':
            return <LegalBasisCard key={index} card={card} />
          default:
            return null
        }
      })}
    </Flex>
  )
}
```

- [ ] **Step 2: Modify `AgentResponse.tsx` to parse and render cards**

At the top, import:

```tsx
import { parseGridCards } from '../utils/parseGridCards'
import { GridCards } from './GridCards'
```

Inside the component, before the render guard, add:

```tsx
const { text: displayText, cards } = parseGridCards(content)
```

Replace all uses of `content` in the rendered markdown with `displayText`:

```tsx
<MarkdownRenderer content={displayText} />
```

Add the cards renderer inside the flex column, after the markdown content, in both the `inline` and `default` variants:

```tsx
<MarkdownRenderer content={displayText} />
{cards.length > 0 && <GridCards cards={cards} />}
```

- [ ] **Step 3: Ensure the render guard handles card-only messages**

Change the existing guard from:

```tsx
if (!content || !content.trim() || content === 'null') {
  return null
}
```

to:

```tsx
const { text: displayText, cards } = parseGridCards(content || '')
const hasContent = displayText && displayText.trim() && displayText !== 'null'
if (!hasContent && cards.length === 0) {
  return null
}
```

Then use `displayText` and `cards` for rendering.

- [ ] **Step 4: Stage and commit**

```bash
git add frontends/ui/src/features/chat/components/AgentResponse.tsx frontends/ui/src/features/chat/components/GridCards.tsx
git commit -s -m "feat(ui): render Grid cards inside agent responses"
```

---

### Task 8: Persist parsed cards with the message

**Files:**
- Modify: `frontends/ui/src/features/chat/store.ts` (or wherever `completeAssistantMessage`/`addAgentResponse` live)

- [ ] **Step 1: Find the message finalization code**

Search for `completeAssistantMessage`, `addAgentResponse`, or `addAgentResponseWithMeta`.

- [ ] **Step 2: Parse cards when finalizing an assistant message**

When an assistant message is completed, parse its content and store `cards` on the message object. Example insertion point:

```ts
import { parseGridCards } from './utils/parseGridCards'

// In the action that completes the assistant message:
completeAssistantMessage: () => set((state) => {
  const conv = state.currentConversation
  if (!conv) return state
  const lastMsg = conv.messages[conv.messages.length - 1]
  if (lastMsg?.role !== 'assistant') return state

  const { cards } = parseGridCards(lastMsg.content)
  lastMsg.cards = cards
  return { ...state }
})
```

If the store already has a `completeAssistantMessage` action, modify that existing function rather than adding a new one.

- [ ] **Step 3: Stage and commit**

```bash
git add frontends/ui/src/features/chat/store.ts
git commit -s -m "feat(ui): persist parsed cards on chat messages"
```

---

### Task 9: Frontend verification

- [ ] **Step 1: Run TypeScript check**

```bash
cd frontends/ui
npm run type-check
```

Expected: no new type errors.

- [ ] **Step 2: Run linter**

```bash
npm run lint
```

Expected: no new lint errors.

- [ ] **Step 3: Run tests**

```bash
npm run test:ci
```

Expected: all tests pass, including the new `parseGridCards` test.

- [ ] **Step 4: Build the frontend**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Mark phase complete**

Update the parent TodoWrite: Phase 3 complete.
