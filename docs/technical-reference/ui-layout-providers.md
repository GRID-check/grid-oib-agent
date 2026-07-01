# UI Layout & Providers Architecture

## Root Layout

**File:** `frontends/ui/src/app/layout.tsx`

The root layout is an async server component that:

1. Calls `connection()` to opt into dynamic rendering (avoids static generation).
2. Reads server-side environment variables to build an `AppConfig` object:
   - `REQUIRE_AUTH` — whether authentication is required
   - `getFileUploadConfigFromEnv(process.env)` — max file size, allowed types, etc.
3. Renders `<html id="style-root">` with the CDN SVG loader script and passes `AppConfig` to the client `Providers`.

```tsx
// Pseudocode structure
<AppConfigProvider config={config}>
  {children}
</AppConfigProvider>
```

Metadata: title "Grid", description "AI-powered research assistant", favicon at `/favicon.ico`.

---

## Providers Tree

**File:** `frontends/ui/src/app/providers.tsx`

Nesting order (outermost to innermost):

```
AppConfigProvider
  AuthKitProvider               (WorkOS AuthKit session)
    ThemeWrapper                (theme sync + data sources init)
      DeepResearchRestorer     (reconnects active jobs on mount)
        ConversationsHydrator  (loads server conversations on mount)
          {children}
```

### ThemeWrapper

- Reads `theme` from `useLayoutStore` (light / dark / system).
- Calls `useThemeEffect(theme)` — applies `nv-light` or `nv-dark` CSS classes directly to `document.documentElement`, avoiding component remounts.
- For `system` theme: listens to `prefers-color-scheme` media query and updates live.
- Defers theme application until after hydration to prevent SSR mismatch.
- Calls `useDataSourcesInit()` — fetches available data sources from the API on first mount (if not already loaded).
- Calls `useDataSourceSessionRestore()` — after the API data sources load, restores the per-conversation data source selection from the chat store (saved per-session).

### DeepResearchRestorer

- Uses a `mounted` ref to skip SSR.
- On mount, calls two chat store actions:
  1. `reconnectToActiveJob()` — reconnects to running/submitted deep research jobs (page refresh recovery).
  2. `cleanupOrphanedStartingBanners()` — polls job status via REST to remove stale "starting" banners.
- Guarded: only runs when a `currentConversationId` is set and deep research is not already streaming.

### ConversationsHydrator

- Calls `loadServerConversations()` once on mount (guarded by a `loadedRef`).
- Merges server-persisted conversations into the local chat store.

---

## MainLayout Component

**File:** `frontends/ui/src/features/layout/components/MainLayout.tsx`

Orchestrates all visible panels and areas. Accepts `isAuthenticated` and `onSignIn` props.

### Layout Regions

```
┌─────────────────────────────────────────┐
│               AppBar                     │  (top, fixed)
├────────┬──────────────────┬─────────────┤
│        │                  │  Research   │
│Sessions│   ChatArea       │  Panel      │
│Panel   │   (scrollable)   │  (push, 60%)│
│(overlay)│                  │             │
│        │   NoSourcesBanner│             │
│        │   InputArea      │             │
│        │   (fixed bottom) │             │
├────────┴──────────────────┴─────────────┤
│  DataSourcesPanel (overlay, right)       │
│  SettingsPanel    (overlay, right)       │
└─────────────────────────────────────────┘
```

### Panel Behavior

| Panel | Side | Behavior | Trigger |
|-------|------|----------|---------|
| SessionsPanel | Left | Overlay (slides over content) | `isSessionsPanelOpen` state |
| ResearchPanel | Right | Push (content shrinks to 40%) | `rightPanel === 'research'` |
| DataSourcesPanel | Right | Overlay (slides over content) | `rightPanel === 'data-sources'` |
| SettingsPanel | Right | Overlay (slides over content) | `rightPanel === 'settings'` |

ResearchPanel uses a CSS `width` transition (`600ms ease-in-out`) on the center content div. When open, the center area takes 40% width and the research panel takes 60%. Respects `prefers-reduced-motion`.

### Chat Store Integration

MainLayout reads from `useChatStore` via `useShallow`:
- `currentConversation`, `conversations`, `isStreaming`, `pendingInteraction`, `isDeepResearchStreaming`, `deepResearchOwnerConversationId`, `currentUserId`

Derives session list for the SessionsPanel, annotating each with:
- `hasActiveDeepResearch` — checks messages for active jobs OR checks if the current streaming job belongs to this conversation.
- `hasCompletedReport` / `hasExpiredReport` — via `session-activity` helpers.

### URL Sync

Uses `useSessionUrl` hook to sync the current conversation ID with URL query parameters. Wraps `selectConversation` and `deleteConversation` to update/clear the URL.

### Handlers

- `handleSelectSession` — selects conversation + updates URL.
- `handleNewSession` — starts a draft, clears URL, opens DataSources panel (if authenticated).
- `handleDeleteSession` — deletes conversation + clears URL if it was the current.
- `handleDeleteAllSessions` — deletes all + clears URL.

Navigation is blocked (`isNavigationBlocked`) when streaming or waiting for a human interaction.

---

## Layout Store

**File:** `frontends/ui/src/features/layout/store.ts`

Zustand store with `devtools` middleware, named `LayoutStore`.

### State

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `isSessionsPanelOpen` | `boolean` | `false` | Left sessions panel visibility |
| `rightPanel` | `RightPanelType` | `'data-sources'` | Active right panel (`'research'` / `'data-sources'` / `'settings'` / `null`) |
| `researchPanelTab` | `'tasks' \| 'thinking' \| 'report'` | `'tasks'` | Active research panel tab |
| `dataSourcesPanelTab` | `'connections' \| 'files'` | `'connections'` | Active data sources tab |
| `enabledDataSourceIds` | `string[]` | `[]` | IDs of currently enabled data sources |
| `theme` | `ThemeMode` | `'system'` | UI theme |
| `availableDataSources` | `DataSourceFromAPI[] \| null` | `null` | Data sources fetched from API (`null` = not loaded) |
| `knowledgeLayerAvailable` | `boolean` | `false` | Whether file upload (knowledge layer) is available |
| `dataSourcesLoading` | `boolean` | `false` | Loading state for data sources fetch |
| `dataSourcesError` | `string \| null` | `null` | Error message from data sources fetch |

### Actions

| Action | Signature | Description |
|--------|-----------|-------------|
| `toggleSessionsPanel` | `() => void` | Toggle left panel |
| `setSessionsPanelOpen` | `(open: boolean) => void` | Set left panel state |
| `openRightPanel` | `(panel: RightPanelType) => void` | Open a specific right panel |
| `closeRightPanel` | `() => void` | Close the right panel |
| `setResearchPanelTab` | `(tab: ResearchPanelTab) => void` | Set research tab |
| `setDataSourcesPanelTab` | `(tab: DataSourcesPanelTab) => void` | Set data sources tab |
| `toggleDataSource` | `(id: string) => void` | Toggle a data source on/off |
| `setEnabledDataSources` | `(ids: string[]) => void` | Replace all enabled IDs |
| `setTheme` | `(theme: ThemeMode) => void` | Change theme |
| `fetchDataSources` | `(authToken?: string) => Promise<void>` | Fetch from API, enable all returned sources |
| `disableAuthRequiredSources` | `() => void` | Remove sources with `requires_auth` flag |
| `setAvailableDataSources` | `(sources: DataSourceFromAPI[]) => void` | Direct setter |
| `setKnowledgeLayerAvailable` | `(available: boolean) => void` | Direct setter |

### Data Sources Flow

1. On app mount, `ThemeWrapper` calls `fetchDataSources()`.
2. The API returns `{ data_sources: [...], knowledge_layer: boolean }`.
3. All returned sources are enabled by default in the store.
4. On conversation change, `useDataSourceSessionRestore` overrides with the per-conversation selection (saved in the conversation's `enabledDataSourceIds`).
5. When auth state changes, `disableAuthRequiredSources` strips sources requiring auth.
6. Users can toggle individual sources at any time via `toggleDataSource`.

### Types

**File:** `frontends/ui/src/features/layout/types.ts`

```typescript
type ThemeMode = 'light' | 'dark' | 'system'
type RightPanelType = 'research' | 'data-sources' | 'settings' | null
type ResearchPanelTab = 'tasks' | 'thinking' | 'report'
type DataSourcesPanelTab = 'connections' | 'files'
```
