# shadcn/ui Migration Plan (v2 — per-screen rewrite)

**Goal:** shadcn/ui becomes the ONLY component library. KUI Foundations (`@nvidia/foundations-react-core` + `kui-generated.css`) is removed entirely. TanStack Form + Zod for all forms. Design: understated, premium, minimalist — hairline borders, near-monochrome zinc, one blue accent, no gradients, no emojis.

**Approach:** rewrite screen by screen along user journeys. Each migrated file uses only `@/components/ui/*`, `@/components/form`, lucide-react, and plain semantic HTML + Tailwind. **No compat/shim layer. No Flex/Stack/Divider/Text abstractions** — layout is `<div className="flex flex-col gap-3">`, typography is `<h2 className="text-lg font-semibold">`. Migrated code should read as if the app had always been built on shadcn.

## Foundation (in place)

| Piece | Path |
|---|---|
| Tokens: shadcn vars + legacy semantic vars (light/dark via `.nv-dark`) | `src/styles/tokens.css` |
| `dark:` variant bound to `.nv-dark`, tw-animate imported | `src/app/globals.css` |
| `cn()` | `src/lib/utils.ts` |
| shadcn primitives (React-18 forwardRef) | `src/components/ui/*` |
| TanStack Form + Zod system (`useAppForm`) | `src/components/form/index.tsx` |

Legacy semantic utility classes (`text-subtle`, `bg-surface-sunken`, `border-base`, …) keep working through tokens.css during the transition; migrated screens may keep using them (they are our tokens now) or shadcn-idiomatic classes (`text-muted-foreground`, `bg-muted`, `border`) — prefer shadcn idiom in rewritten code.

## Rewrite rules

1. Remove every `@/adapters/ui` import from the file. Replace:
   - Layout components → plain elements + Tailwind flex/grid.
   - `Text` → semantic elements (`h1–h4`, `p`, `span`, `label`) with type classes. Ramp: page title `text-2xl font-semibold tracking-tight`; section `text-lg font-semibold`; body `text-sm`; captions `text-xs text-muted-foreground`.
   - Buttons/inputs/dialogs/etc. → `@/components/ui/*` directly (Button variants: default/outline/ghost/destructive; confirm-delete dialogs use Dialog composition).
   - `Banner` → `Alert`; `Toast` → `sonner`; icons → lucide-react (drop `adapters/ui/icons.tsx` CDN icons in migrated files).
2. Forms → `useAppForm` + colocated Zod schema. No hand-rolled `useState` field state.
3. Behavior, data flow, handlers, and copy stay identical (except emoji → lucide, German → English fixes).
4. Journey-first: when rewriting a screen, fix incoherent spacing/hierarchy so the screen reads calmly — but no feature changes.
5. `.spec` files: update to match new markup minimally (roles/labels should mostly survive since semantics improve).
6. No installers, no test runs. Static re-read for correctness.

## Icon migration (adapters/ui/icons → lucide-react)

Migrated files import icons from `lucide-react` directly. Mapping for the CDN icon names in use: Close→X, Edit→Pencil, OpenExternal→ExternalLink, Refresh→RefreshCw, Send/Paperplane→SendHorizontal, Chat→MessageSquare, ChatMessage→MessageSquareText, Warning→AlertTriangle, Error/Cancel→XCircle, Success/CheckCircle→CheckCircle2, Logout→LogOut, Document→FileText, DocumentCheckmark→FileCheck2, Trash→Trash2, Book→BookOpen, Help→CircleHelp, Wand→Wand2, Sort→ArrowUpDown, Share→Share2, Retry→RotateCcw, StopCircle→CircleStop, ChartFlow→Workflow, Generate→Sparkles, ThinkingReasoning→BrainCircuit, LoadingSpinner→`<Spinner>` from `@/components/ui/spinner`. Same-name icons (ChevronDown, Search, Plus, Globe, Clock, Lock, Info, Settings, Sun, Moon, Paperclip, Folder, User, Users, …) map 1:1. Sizing: KUI icons took h-4 w-4 style classes — keep the same classes on lucide icons.

## Component translation notes (from usage probe)

- `SegmentedControl` → `Tabs` (`TabsList` + `TabsTrigger` per item, `value`/`onValueChange` preserved).
- `SidePanel` (Settings/Sessions/DataSources panels) → plain conditional `<aside>` docked right under the header (`fixed right-0 top-[var(--header-height)] h-[calc(100vh-var(--header-height))] w-[400px] border-l border-base bg-surface-base`), with heading row + scrollable body + footer; no overlay, no click-outside (matches current behavior `closeOnClickOutside={false}`). Add a slide-in transition (translate-x) honoring prefers-reduced-motion.
- `Popover slotContent=` → shadcn `Popover` + `PopoverTrigger asChild` + `PopoverContent side/align`; user menus may use `DropdownMenu` where menu semantics fit better.
- KUI `TextArea onValueChange/resizeable="auto"` → shadcn `Textarea` + `onChange`, with a small autosize effect (set height from scrollHeight, capped).
- KUI `Upload` (FileUploadZone) → hidden `<input type="file" multiple>` + styled drop target + file card list; preserve the existing value/onValueChange contract inside the file.
- `CodeSnippet` → bespoke code block: `<pre>` with language label + copy button (lucide Copy/Check), collapsible when >15 lines.
- `Badge color="blue"` → `<Badge variant="outline" className="border-brand/30 text-brand">`.
- `Modal` confirm dialogs → `Dialog` + `DialogContent/Header/Title/Footer` + `DialogClose asChild` for Cancel.

## Journey fan-out

| Wave | Journey | Scope |
|---|---|---|
| 1 | Projects | `app/projects/**`, `components/projects/*` (create form → TanStack), `features/projects/*` (overview, intake wizard → TanStack, file panes) |
| 1 | Onboarding & auth | `app/onboarding/**` (org form → TanStack), `app/auth/error` |
| 2 | Chat shell | `features/layout/*`: AppBar/GlobalTopNav/ChatToolbar/MainLayout, Sessions/Settings/DataSources panels (SidePanel → custom docked panel on Dialog primitives or plain fixed aside), InputArea, ChatArea |
| 2 | Chat content | `features/chat/*` (MarkdownRenderer, ChatThinking, banners), `features/grid-cards/*` |
| 3 | Documents | `features/documents/*` (Uppy zones, explorer, panes) |
| 4 | Cleanup | delete `src/adapters/ui` (keep `Logo` moved to `components/brand/logo.tsx`), remove `@nvidia/foundations-react-core`, `kui-generated.css`, `kui-safelist.txt`, external-svg-loader script; move still-needed `@utility` defs; rename `.nv-dark` → `.dark` (providers.tsx + tokens.css + globals.css); update `test-utils` |

Waves 1–3 can run in parallel where directories don't overlap. Cleanup last, when `grep -r "@/adapters/ui" src` (minus Logo) is empty.
