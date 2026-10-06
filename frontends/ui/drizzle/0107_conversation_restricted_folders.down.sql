-- Reverse 0107. ORDER: roll the frontend back first; the newer build writes and
-- reads `conversation_restricted_folders`.
--
-- Not lossless, and in the safe direction: every conversation with a recorded
-- folder gets back its 0105 mark, which the older build reads as "stays with
-- its owner". Which folders it drew on is lost; the older build never knew it.
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
COMMENT ON TABLE "conversation_restricted_turns" IS
  'A turn of this conversation ran with a restricted folder''s collection in its signed scope (ADR-0078). Written at turn start by the confinement route; the sharing service refuses to widen a conversation that has a row here.';
SELECT grid_secure_table('conversation_restricted_turns', 'organization_id = grid_current_org()');
INSERT INTO "conversation_restricted_turns" ("organization_id", "conversation_id", "first_at", "last_at")
SELECT "organization_id", "conversation_id", min("first_at"), max("last_at")
FROM "conversation_restricted_folders"
GROUP BY "organization_id", "conversation_id"
ON CONFLICT DO NOTHING;
DROP TABLE IF EXISTS "conversation_restricted_folders";
