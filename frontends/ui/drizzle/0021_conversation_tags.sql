-- Conversation topic tags (Historie chat naming + tag filter).
-- A conversation carries 0–3 OIB-topic tag keys from a fixed vocabulary
-- (see lib/conversations/tags.ts), assigned by the same LLM call
-- that names the chat. Stored as a Postgres text[] so a conversation can hold
-- multiple tags; defaults to empty so every existing row stays valid.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
-- Serves the Historie tag filter (array-membership / overlap queries).
CREATE INDEX IF NOT EXISTS "conversations_tags_idx" ON "conversations" USING gin ("tags");
