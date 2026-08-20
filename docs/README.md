# Grid AIQ Documentation

Documentation for the AI-powered OIB building regulation research assistant. See the [root README](../README.md) for a project overview.

## User Guides

| File | Description |
|------|-------------|
| [Chat](user-guides/chat.md) | How users interact with the chat interface, conversation workflows, and data source toggles |
| [Projects](user-guides/projects.md) | Organizing documents and chats into projects with access control |
| [Documents](user-guides/documents.md) | Uploading, tracking, and downloading documents through the UI |
| [Reports Piloti Writes](user-guides/agent-authored-reports.md) | Where a deep-research report is filed, how it is marked as machine-written, why it stays out of the knowledge base, and who is responsible for it |
| [Knowledge Search](user-guides/knowledge-search.md) | How the AI searches OIB knowledge base and uploaded documents |
| [Keyboard Shortcuts](user-guides/keyboard-shortcuts.md) | The command palette, `g …` section jumps, composer keys, and the two gates that enable them |

## Technical Reference

| File | Description |
|------|-------------|
| [Architecture Overview](technical-reference/architecture-overview.md) | Two-tier architecture (Next.js BFF + Python FastAPI), component diagram, data flow |
| [Authentication Flow](technical-reference/authentication-flow.md) | WorkOS AuthKit sign-in, session resolution, JWT validation, anonymous mode |
| [Chat Flow](technical-reference/chat-flow.md) | SSE and WebSocket chat implementations, chat store, message streaming |
| [Collection Scoping](technical-reference/collection-scoping.md) | How X-Grid-Collection-Scope is computed by the BFF and consumed by Python |
| [Conversation Persistence](technical-reference/conversation-persistence.md) | Drizzle schema, BFF CRUD routes, store hydration, per-message persistence |
| [Document Ingestion](technical-reference/document-ingestion.md) | SeaweedFS upload, Python /v1/ingest, LlamaIndex chunking/embedding, ChromaDB |
| [OIB Sync](technical-reference/oib-sync.md) | Incremental OIB PDF ingestion with SHA-256 hash registry |
| [WebSocket Gateway](technical-reference/websocket-gateway.md) | Node.js gateway WebSocket proxy, scope resolution, auth forwarding |
| [BFF Proxy Pattern](technical-reference/bff-proxy-pattern.md) | BFF route pattern for auth, scope injection, error handling, SSE passthrough |
| [Projects Access Control](technical-reference/projects-access-control.md) | WorkOS FGA project permissions: view, edit, manage, chat |
| [UI Layout & Providers](technical-reference/ui-layout-providers.md) | App Router structure, providers, MainLayout, panel system, Zustand store |

## Deployment

| File | Description |
|------|-------------|
| [Docker Compose](deployment/docker-compose.md) | Service reference for all 5 containers: images, ports, volumes, healthchecks, networks |
| [Environment Variables](deployment/environment-variables.md) | Complete env var reference organized by category, with defaults and source locations |
| [Startup Flow](deployment/startup-flow.md) | Detailed boot sequence: PostgreSQL init, SeaweedFS, Dask cluster, uvicorn, Next.js gateway |
| [Security Config](deployment/security-config.md) | Auth configuration, SeaweedFS credentials, API key management, secrets recommendations |

## API Reference

| File | Description |
|------|-------------|
| [BFF Routes](api/bff-routes.md) | All Next.js API route handlers: auth, chat, conversations, documents, projects, health |
| [Python Endpoints](api/python-endpoints.md) | All FastAPI backend endpoints: collections, documents, ingestion, chat, health |
| [WebSocket Protocol](api/websocket-protocol.md) | NAT WebSocket protocol messages, client API, connection lifecycle |

## Database

| File | Description |
|------|-------------|
| [Schema](database/schema.md) | All 5 grid_app tables (projects, conversations, messages, documents, user_preferences) |
| [Migrations](database/migrations.md) | Drizzle Kit migration workflow and 4-migration history |
