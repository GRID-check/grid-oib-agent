# AI Knowledge Search

The AI can draw information from multiple knowledge sources when answering your questions. This guide explains what's searchable and how to control it.

---

## What the AI Searches

The AI automatically searches these sources — you don't need to ask it to "search" explicitly:

### 1. OIB Richtlinien (Default Knowledge Base)

The OIB (Österreichisches Institut für Bautechnik) guidelines are pre-ingested into a persistent collection named `oib_knowledge`. These PDFs cover Austrian building code regulations. The AI consults this base automatically whenever it needs regulatory or technical building information.

This collection is always included in every query's scope and is **never** auto-deleted.

### 2. Uploaded Documents (Project-Scoped)

Documents uploaded to a project via the project upload zone are ingested into collection `proj_{projectId}`. Only users with access to that project can search its documents. The AI searches project-scoped documents when you're working within that project context.

### 3. Uploaded Documents (Session-Scoped)

Files uploaded directly within a conversation are stored in collection `s_{conversationId}` and are searchable only within that conversation. These are temporary — they are automatically cleaned up after 24 hours of inactivity.

---

## Controlling Which Sources Are Searched

### Data Source Toggles

The **Data Sources** panel in the UI lets you enable or disable:

- **Web Search** — When enabled, the AI can search the web for current information. When disabled, the AI relies only on the locally ingested knowledge base and uploaded documents.
- **Knowledge Base** — Always enabled when OIB documents have been ingested. Toggling this off prevents the AI from searching any document collections.

### Telling the AI What to Search

Natural language instructions work well:

- *"Search my documents for information about fire safety regulations"*
- *"Find info from the OIB about staircase dimensions"*
- *"Look in my uploaded files for the structural analysis report"*
- *"Search the web for current Austrian building code updates"*

The AI's knowledge retrieval function (`knowledge_retrieval`) is triggered automatically when the agent determines it needs external information. You can also explicitly ask it to perform a search.

---

## How Results Are Presented

When the AI finds relevant information, it returns:

- **Cited excerpts** — Each result includes the source filename and page number
- **Relevance scores** — A 0.0–1.0 score indicating how closely the chunk matches your query
- **Content type labels** — Whether the result comes from text, a table, a chart, or an image caption

Results from multiple collections are merged by relevance score and deduplicated before being presented.

---

## Document Summaries

The document list in the Data Sources panel shows a **summary** for each successfully ingested document (if summarization is enabled in the configuration). Summaries provide quick context about what each document contains without needing to search it first.

Summaries are generated during ingestion using the configured `summary_model` LLM and stored in a centralized registry (SQLite by default).

---

## Web Search

Web search is provided by a separate NAT function. When enabled:

- The AI can fetch and cite current information from the internet
- Web results supplement the local knowledge base
- The toggle is available in the Data Sources panel

To use it, ensure Web Search is enabled in the panel and ask a question that requires current information.

---

## Collection Scoping

The system automatically determines which ChromaDB collections to search for each request. This scoping is transparent to the user:

- **Project context** — If you are working in a project, `proj_{projectId}` is included
- **Conversation context** — If you have a conversation open, `s_{conversationId}` is included
- **Base knowledge** — `oib_knowledge` is always included as the default collection

For technical details, see the [Collection Scoping](../technical-reference/collection-scoping.md) reference.
