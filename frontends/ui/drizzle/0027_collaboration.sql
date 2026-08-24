-- Collaboration: sharing, message authorship, mentions, inbox, read state.
-- Specs: docs/design/collaboration-sharing-and-inbox-spec.md
-- Decisions: ADR-0032 (sharing model), ADR-0034 (mention hand-off), ADR-0035 (inbox)
--
-- Hand-written rather than drizzle-kit generated: drizzle/meta snapshots stop at
-- 0011 while the journal runs to 0026, so `drizzle-kit generate` would diff
-- against a 15-migration-old snapshot and emit SQL recreating existing tables.
-- Same reason 0017/0019/0024/0026 are hand-written with descriptive names.

--> statement-breakpoint
-- 1. Message authorship. NULL for assistant/system/tool rows and for messages
--    written before authorship existed; legacy rows are attributed to the
--    conversation creator at READ time, never backfilled, so the column never
--    claims a precision the data does not have (spec MG-3).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "author_user_id" text;

--> statement-breakpoint
-- 2. Conversation visibility. The column default is 'private' so NEW
--    conversations are private and sharing is a deliberate act.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'private' NOT NULL;

--> statement-breakpoint
-- 2b. DELIBERATE BACKFILL of pre-existing rows to 'project' (spec MG-1, OQ-1).
--
--     Before this migration, conversations were resolved ORG-SCOPED ONLY
--     (findConversationInOrg), so any org member holding a conversation id could
--     read its messages and the unfiltered list returned every conversation in
--     the org. "Private" did not exist.
--
--     'project' is the honest analogue of the intent: everyone who can reach the
--     containing project keeps their access, and the accidental org-wide read by
--     members OUTSIDE the project is withdrawn. This is a deliberate tightening,
--     not a side effect.
--
--     Rows with a NULL project_id (created before project stamping) are left
--     'private' and belong to their creator: there is no project whose
--     membership could define a wider audience for them.
UPDATE "conversations" SET "visibility" = 'project' WHERE "project_id" IS NOT NULL;

--> statement-breakpoint
-- 3. Resource-level grants — the one generic sharing table (ADR-0032).
CREATE TABLE IF NOT EXISTS "resource_shares" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" text NOT NULL,
    "resource_type" text NOT NULL,
    "resource_id" text NOT NULL,
    "subject_user_id" text NOT NULL,
    "role" text NOT NULL,
    "granted_by" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_resource_shares_resource_subject"
    ON "resource_shares" ("resource_type", "resource_id", "subject_user_id");

--> statement-breakpoint
-- "Everything shared with me" — the reverse lookup this table exists for, and
-- the reason grants are NOT in WorkOS FGA (ADR-0032).
CREATE INDEX IF NOT EXISTS "idx_resource_shares_org_subject"
    ON "resource_shares" ("organization_id", "subject_user_id", "resource_type");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_shares_resource"
    ON "resource_shares" ("resource_type", "resource_id");

--> statement-breakpoint
-- 4. Mention requests — the durable hand-off state (ADR-0034). The thread-level
--    "awaiting X" banner is DERIVED from open rows here, never stored twice.
CREATE TABLE IF NOT EXISTS "mention_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" text NOT NULL,
    "resource_type" text NOT NULL,
    "resource_id" text NOT NULL,
    "anchor_id" text,
    "requested_by" text NOT NULL,
    "requested_of" text NOT NULL,
    "note" text,
    "status" text DEFAULT 'open' NOT NULL,
    "resolution" text,
    "resolved_by" text,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mention_requests_resource_status"
    ON "mention_requests" ("resource_type", "resource_id", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mention_requests_requested_of_status"
    ON "mention_requests" ("requested_of", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mention_requests_org_requested_by"
    ON "mention_requests" ("organization_id", "requested_by", "status");

--> statement-breakpoint
-- 5. Inbox items — one generic frame + typed payload (ADR-0035).
CREATE TABLE IF NOT EXISTS "inbox_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" text NOT NULL,
    "recipient_user_id" text NOT NULL,
    "type" text NOT NULL,
    "resource_type" text NOT NULL,
    "resource_id" text NOT NULL,
    "anchor_id" text,
    "actor_user_id" text,
    "group_key" text NOT NULL,
    "actionable" boolean NOT NULL,
    "count" integer DEFAULT 1 NOT NULL,
    "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "read_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "archived_at" timestamp with time zone,
    "inert_at" timestamp with time zone
);

--> statement-breakpoint
-- Grouping + deduplication + idempotency from ONE constraint: the emit path
-- upserts on this key, incrementing `count` and touching `updated_at`.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbox_items_recipient_group"
    ON "inbox_items" ("recipient_user_id", "group_key");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_items_recipient_org_updated"
    ON "inbox_items" ("recipient_user_id", "organization_id", "updated_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_items_target"
    ON "inbox_items" ("resource_type", "resource_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_items_created_at"
    ON "inbox_items" ("created_at");

--> statement-breakpoint
-- The badge count runs on EVERY page render, so it gets a partial index that
-- matches its predicate exactly. Drizzle's builder cannot express a partial
-- index, so it lives here (same precedent as idx_workflows_due in 0017).
-- "Needs attention" = not archived, not inert, and either unread or an
-- unresolved actionable request.
CREATE INDEX IF NOT EXISTS "idx_inbox_items_pending"
    ON "inbox_items" ("recipient_user_id", "organization_id")
    WHERE "archived_at" IS NULL
      AND "inert_at" IS NULL
      AND ("read_at" IS NULL OR ("actionable" AND "resolved_at" IS NULL));

--> statement-breakpoint
-- 6. Per-participant read high-water mark. Cascades with the conversation.
CREATE TABLE IF NOT EXISTS "conversation_reads" (
    "conversation_id" text NOT NULL,
    "user_id" text NOT NULL,
    "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_read_message_id" text,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "conversation_reads_pk" PRIMARY KEY ("conversation_id", "user_id")
);

--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "conversation_reads"
        ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk"
        FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
        ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
