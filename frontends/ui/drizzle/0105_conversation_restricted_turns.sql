-- 0105: conversation_restricted_turns — a turn of this conversation ran with a
-- restricted folder's collection in its scope (ADR-0078).
--
-- ## Why a row of its own, written at turn START
--
-- A conversation that drew on a restricted folder stays with its owner. The
-- first signal for "drew on" was the stored answers' `citations` and
-- `readSources` naming a `_r…` collection. That misses two cases:
--
--   * the inventory block puts every in-scope document's summary into the
--     prompt before the first tool call, so an answer can use a restricted
--     summary without citing or reading anything, and records no source;
--   * nothing is stored while the first restricted answer is still streaming,
--     so the owner could share the thread mid-turn and the finished answer
--     would land in a shared thread.
--
-- The agent already asks the BFF before every turn whose signed scope holds a
-- restricted collection (`POST /api/internal/conversations/[id]/confinement`).
-- That route writes this row before it answers yes, so the mark exists before
-- the turn has produced a word, and the share refusal keys on it.
--
-- ## No foreign key to conversations
--
-- The first turn of a new chat runs before its conversation row exists (the
-- first message creates it). The conversation erasure deletes the row
-- explicitly (`deleteConversationInOrg`).
--
-- ## turn_count
--
-- How many restricted turns asked. A mark at 1 is one only its first asker
-- wrote: when that ask is refused (the thread was shared meanwhile), the route
-- withdraws it with `WHERE turn_count = 1`, and leaves a mark a concurrent
-- turn also wrote.

CREATE TABLE IF NOT EXISTS "conversation_restricted_turns" (
  "organization_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  "turn_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "conversation_restricted_turns_pk" PRIMARY KEY ("organization_id", "conversation_id"),
  CONSTRAINT "conversation_restricted_turns_turn_count" CHECK ("turn_count" >= 1),
  CONSTRAINT "conversation_restricted_turns_order" CHECK ("last_at" >= "first_at")
);
--> statement-breakpoint
COMMENT ON TABLE "conversation_restricted_turns" IS
  'A turn of this conversation ran with a restricted folder''s collection in its signed scope (ADR-0078). Written at turn start by the confinement route; the sharing service refuses to widen a conversation that has a row here.';
--> statement-breakpoint
SELECT grid_secure_table('conversation_restricted_turns', 'organization_id = grid_current_org()');
