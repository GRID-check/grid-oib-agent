# Grid MVP Implementation Plan — Server-Side Conversation Persistence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist conversations and messages server-side in `grid_app` and wire them into the existing AI-Q WebSocket transport and frontend Zustand store.

**Architecture:** A new FastAPI plugin (`ConversationAPIPlugin`) exposes REST CRUD. The `ReconnectableWebSocketMessageHandler` loads history on connect and writes user/system messages as they are produced. The frontend Zustand store fetches server conversations after auth and falls back to localStorage as a cache.

**Tech Stack:** PostgreSQL `grid_app`, Drizzle ORM (Next.js), SQLAlchemy/asyncpg (Python), FastAPI, AI-Q WebSocket handler, NAT WebSocket message schema.

---

## File structure

| File | Responsibility |
|---|---|
| `frontends/ui/src/lib/db/schema/conversations.ts` | Drizzle schema for `conversations` and `messages`. |
| `src/aiq_agent/persistence/models.py` | SQLAlchemy `Conversation`, `Message` models. |
| `src/aiq_agent/persistence/repository.py` | CRUD operations for conversations/messages. |
| `src/aiq_agent/persistence/service.py` | Business logic: load history, append messages. |
| `src/aiq_agent/fastapi_extensions/plugins/conversation_routes.py` | REST endpoints. |
| `src/aiq_agent/fastapi_extensions/plugins/conversation_plugin.py` | Plugin registration. |
| `frontends/ui/src/lib/api/conversations.ts` | Client-side conversation API helpers. |
| `frontends/ui/src/features/chat/store.ts` | Add `loadServerConversations` action. |
| `tests/aiq_agent/persistence/test_repository.py` | Unit tests for persistence layer. |

---

### Task 1: Define `grid_app.conversations` and `grid_app.messages` schema

**Files:**
- Create: `frontends/ui/src/lib/db/schema/conversations.ts`

- [ ] **Step 1: Write Drizzle schema**

```typescript
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  projectId: uuid("project_id"),
  createdBy: text("created_by").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .references(() => conversations.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role").notNull(), // 'user' | 'system' | 'tool' | 'error'
  content: text("content").notNull(),
  cards: jsonb("cards"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 2: Add indexes**

Add to `conversations.ts`:

```typescript
import { index } from "drizzle-orm/pg-core";

export const conversations = pgTable("conversations", {
  ...columns
}, (table) => ({
  orgIdx: index("conversations_org_idx").on(table.organizationId),
  projectIdx: index("conversations_project_idx").on(table.projectId),
  userIdx: index("conversations_user_idx").on(table.createdBy),
}));

export const messages = pgTable("messages", {
  ...columns
}, (table) => ({
  conversationIdx: index("messages_conversation_idx").on(table.conversationId),
}));
```

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/lib/db/schema/conversations.ts
git commit -m "feat: add conversations and messages drizzle schema"
```

---

### Task 2: Create SQLAlchemy models in Python

**Files:**
- Create: `src/aiq_agent/persistence/models.py`

- [ ] **Step 1: Implement models**

```python
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(String, nullable=False)
    project_id = Column(UUID(as_uuid=True), nullable=True)
    created_by = Column(String, nullable=False)
    title = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)

    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = "messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    cards = Column(JSON, nullable=True)
    metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")
```

- [ ] **Step 2: Commit**

```bash
git add src/aiq_agent/persistence/models.py
git commit -m "feat: add conversation persistence sqlalchemy models"
```

---

### Task 3: Build repository layer

**Files:**
- Create: `src/aiq_agent/persistence/repository.py`
- Create: `tests/aiq_agent/persistence/test_repository.py`

- [ ] **Step 1: Implement repository**

```python
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from .models import Conversation, Message


class ConversationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_for_user(
        self,
        organization_id: str,
        user_id: str,
    ) -> list[Conversation]:
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.organization_id == organization_id,
                Conversation.created_by == user_id,
            )
            .order_by(Conversation.updated_at.desc())
        )
        return list(result.scalars().all())

    async def get(
        self,
        conversation_id: UUID,
        organization_id: str,
        user_id: str,
    ) -> Conversation | None:
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.id == conversation_id,
                Conversation.organization_id == organization_id,
                Conversation.created_by == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        organization_id: str,
        user_id: str,
        project_id: UUID | None = None,
        title: str | None = None,
    ) -> Conversation:
        conversation = Conversation(
            organization_id=organization_id,
            created_by=user_id,
            project_id=project_id,
            title=title,
        )
        self._session.add(conversation)
        await self._session.flush()
        return conversation

    async def add_message(
        self,
        conversation_id: UUID,
        role: str,
        content: str,
        cards: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Message:
        message = Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            cards=cards,
            metadata=metadata,
        )
        self._session.add(message)
        await self._session.flush()
        return message

    async def load_messages(self, conversation_id: UUID) -> list[Message]:
        result = await self._session.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
        )
        return list(result.scalars().all())
```

- [ ] **Step 2: Write repository tests**

```python
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from aiq_agent.persistence.models import Base
from aiq_agent.persistence.repository import ConversationRepository


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with async_session() as s:
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_and_list_conversations(session):
    repo = ConversationRepository(session)
    conv = await repo.create("org_1", "user_1", title="Test")
    convs = await repo.list_for_user("org_1", "user_1")
    assert len(convs) == 1
    assert convs[0].title == "Test"


@pytest.mark.asyncio
async def test_add_and_load_messages(session):
    repo = ConversationRepository(session)
    conv = await repo.create("org_1", "user_1")
    await repo.add_message(conv.id, "user", "hello")
    await repo.add_message(conv.id, "system", "hi")
    messages = await repo.load_messages(conv.id)
    assert len(messages) == 2
    assert messages[0].role == "user"
    assert messages[1].role == "system"
```

- [ ] **Step 3: Run tests**

Run: `cd src/aiq_agent && uv run pytest tests/aiq_agent/persistence/test_repository.py -v`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/aiq_agent/persistence/repository.py tests/aiq_agent/persistence/test_repository.py
git commit -m "feat: add conversation repository with tests"
```

---

### Task 4: Add service layer for history load

**Files:**
- Create: `src/aiq_agent/persistence/service.py`

- [ ] **Step 1: Implement service**

```python
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from .repository import ConversationRepository


class ConversationService:
    def __init__(self, session: AsyncSession) -> None:
        self._repo = ConversationRepository(session)

    async def list_conversations(self, organization_id: str, user_id: str):
        return await self._repo.list_for_user(organization_id, user_id)

    async def load_history(self, conversation_id: UUID, organization_id: str, user_id: str):
        conversation = await self._repo.get(conversation_id, organization_id, user_id)
        if conversation is None:
            return None
        messages = await self._repo.load_messages(conversation_id)
        return {"conversation": conversation, "messages": messages}

    async def create_conversation(
        self,
        organization_id: str,
        user_id: str,
        project_id: UUID | None = None,
        title: str | None = None,
    ):
        return await self._repo.create(organization_id, user_id, project_id, title)

    async def append_message(
        self,
        conversation_id: UUID,
        role: str,
        content: str,
        cards: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ):
        return await self._repo.add_message(conversation_id, role, content, cards, metadata)
```

- [ ] **Step 2: Commit**

```bash
git add src/aiq_agent/persistence/service.py
git commit -m "feat: add conversation service"
```

---

### Task 5: Create FastAPI plugin for conversation routes

**Files:**
- Create: `src/aiq_agent/fastapi_extensions/plugins/conversation_routes.py`
- Create: `src/aiq_agent/fastapi_extensions/plugins/conversation_plugin.py`

- [ ] **Step 1: Implement routes**

```python
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from aiq_agent.common import get_db_session
from aiq_agent.persistence.service import ConversationService

router = APIRouter(prefix="/v1/conversations", tags=["conversations"])


def get_conversation_service(session: AsyncSession = Depends(get_db_session)):
    return ConversationService(session)


@router.get("")
async def list_conversations(
    org_id: str,  # TODO: derive from auth context
    user_id: str,
    service: ConversationService = Depends(get_conversation_service),
):
    return await service.list_conversations(org_id, user_id)


@router.post("")
async def create_conversation(
    org_id: str,
    user_id: str,
    project_id: UUID | None = None,
    title: str | None = None,
    service: ConversationService = Depends(get_conversation_service),
):
    return await service.create_conversation(org_id, user_id, project_id, title)


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: UUID,
    org_id: str,
    user_id: str,
    service: ConversationService = Depends(get_conversation_service),
):
    result = await service.load_history(conversation_id, org_id, user_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Not found")
    return result


@router.post("/{conversation_id}/messages")
async def add_message(
    conversation_id: UUID,
    role: str,
    content: str,
    service: ConversationService = Depends(get_conversation_service),
):
    return await service.append_message(conversation_id, role, content)
```

- [ ] **Step 2: Register plugin**

```python
from aiq_agent.fastapi_extensions.register import register_front_end
from aiq_agent.fastapi_extensions.types import FastApiFrontEndConfig, FastApiFrontEndPluginWorker
from fastapi import FastAPI

from .conversation_routes import router


class ConversationAPIConfig(FastApiFrontEndConfig):
    pass


class ConversationAPIWorker(FastApiFrontEndPluginWorker):
    async def add_routes(self, app: FastAPI, builder):
        app.include_router(router)


class ConversationAPIPlugin:
    Config = ConversationAPIConfig
    Worker = ConversationAPIWorker


register_front_end(config_type=ConversationAPIConfig)(ConversationAPIPlugin)
```

- [ ] **Step 3: Commit**

```bash
git add src/aiq_agent/fastapi_extensions/plugins/conversation_routes.py
    src/aiq_agent/fastapi_extensions/plugins/conversation_plugin.py
git commit -m "feat: add conversation rest plugin"
```

---

### Task 6: Wire history load into WebSocket handler

**Files:**
- Modify: `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`

- [ ] **Step 1: Find the `run()` method**

Read `frontends/aiq_api/src/aiq_api/websocket_reconnect.py` lines ~120-180.

- [ ] **Step 2: Add history load after auth**

After `set_socket` and before the message loop:

```python
from aiq_agent.persistence.service import ConversationService
from aiq_agent.common import get_db_session

async def _load_and_emit_history(self, conversation_id: str, websocket: WebSocket):
    async with get_db_session() as session:
        service = ConversationService(session)
        # TODO: derive org_id and user_id from auth context
        history = await service.load_history(
            UUID(conversation_id), org_id="unknown", user_id="unknown"
        )
    if not history:
        return
    for message in history["messages"]:
        await self.send(
            conversation_id,
            create_websocket_message(
                type=WebSocketMessageType.RESPONSE_MESSAGE,
                id=str(message.id),
                conversation_id=conversation_id,
                content=message.content,
                status="complete",
            ),
        )
```

- [ ] **Step 3: Call it in `run()`**

```python
await self._load_and_emit_history(conversation_id, websocket)
```

- [ ] **Step 4: Commit**

```bash
git add frontends/aiq_api/src/aiq_api/websocket_reconnect.py
git commit -m "feat: load persisted conversation history on websocket connect"
```

---

### Task 7: Persist messages during chat flow

**Files:**
- Modify: `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`

- [ ] **Step 1: Add helper to append user and system messages**

```python
async def _persist_message(
    self,
    conversation_id: str,
    role: str,
    content: str,
    cards: list[dict[str, Any]] | None = None,
):
    async with get_db_session() as session:
        service = ConversationService(session)
        await service.append_message(UUID(conversation_id), role, content, cards)
        await session.commit()
```

- [ ] **Step 2: Call on user message and final response**

In the user-message handler:

```python
await self._persist_message(conversation_id, "user", message.content)
```

When a final system response is emitted:

```python
await self._persist_message(conversation_id, "system", message.content, message.cards)
```

- [ ] **Step 3: Commit**

```bash
git add frontends/aiq_api/src/aiq_api/websocket_reconnect.py
git commit -m "feat: persist chat messages during websocket flow"
```

---

### Task 8: Frontend fetch server conversations

**Files:**
- Create: `frontends/ui/src/lib/api/conversations.ts`
- Modify: `frontends/ui/src/features/chat/store.ts`

- [ ] **Step 1: Add client helpers**

```typescript
export async function listConversations(): Promise<Conversation[]> {
  const res = await fetch("/api/v1/conversations");
  if (!res.ok) throw new Error("Failed to load conversations");
  return res.json();
}

export async function loadConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
  const res = await fetch(`/api/v1/conversations/${id}`);
  if (!res.ok) throw new Error("Failed to load conversation");
  return res.json();
}
```

- [ ] **Step 2: Add store action**

In `frontends/ui/src/features/chat/store.ts`, add:

```typescript
loadServerConversations: async () => {
  const conversations = await listConversations();
  set({ conversations });
},
```

- [ ] **Step 3: Invoke on user/auth change**

Where `setCurrentUser` is called, add after auth resolves:

```typescript
await get().loadServerConversations();
```

- [ ] **Step 4: Commit**

```bash
git add frontends/ui/src/lib/api/conversations.ts frontends/ui/src/features/chat/store.ts
git commit -m "feat: fetch server conversations from frontend"
```

---

## Self-review

**Spec coverage:**
- `grid_app.conversations` + `messages`: Task 1-2.
- REST CRUD: Task 5.
- WebSocket history load: Task 6.
- Message persistence: Task 7.
- Frontend sync: Task 8.

**Placeholder scan:** `org_id` derivation in Task 5 routes is marked `TODO`; this is resolved in the auth plan (Task 12). Need to wire auth context in Task 6 as well. No other TBDs.

**Type consistency:** `conversation_id` is `UUID` everywhere except WebSocket messages where it remains `str` to match NAT schema.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-conversation-persistence-plan.md`.

Defaulting to **Subagent-Driven** implementation.
