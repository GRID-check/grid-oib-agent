-- 0102: inbound_mail_addresses + inbound_mail_messages — the project mail inbox.
--
-- ## Why
--
-- Every project gets an email address. A member mails files to it and the
-- attachments are filed into the project as if that member had uploaded them
-- (ADR-0075). Cloudflare Email Routing hands the raw message to one Worker,
-- which streams it to `POST /api/internal/inbound-mail`; these two tables, and
-- the staged objects the second one names, are everything the BFF keeps.
--
-- ## What the rows hold, and what they do not
--
-- No mail. The webhook verifies the sender, selects the attachments and
-- answers; it never stores the raw message or the body. What it does keep,
-- until the drain has filed them, are the SELECTED attachments, staged as
-- objects under the project's own storage prefix
-- (`org/<org>/project/<project>/inbound-mail/<row>/<n>`), so the purger's
-- project sweep takes them along. The row names those objects (`staged`),
-- the subject and the skipped names for the one notification, and the
-- folder name it will file into. The drain empties `staged`, clears the
-- subject and strips the skipped names once the mail is filed or given up;
-- what stays for 30 days is ids, counts, reason codes, timestamps, the
-- `delivery_key` (a hash) and `folder_name`, which carries the sender's
-- display name because the folder it names does too.
--
-- ## Accept durably, file later
--
-- A delivery is `queued` by the webhook and filed by the drain
-- (`lib/inbound-mail/drain.ts`), which the scheduler container calls every
-- tick. The drain claims a row by writing a fresh `claim_token`, and every
-- later write of that attempt is fenced on it: a run that stalled past the
-- stale window and was reaped cannot overwrite the attempt that took over.
-- `attempts` and `next_attempt_at` are the backoff; after the last attempt
-- the row is `failed` and its staging deleted.
--
-- ## The token is the only thing that resolves
--
-- An address is `<slug>.<token>@<domain>`. The slug is decoration from the
-- project name; two organizations can both have `wohnbau-hietzing`, so only the
-- 12-character token names a project. It is therefore UNIQUE across the whole
-- table, not per organization: the webhook looks it up before any organization
-- is known, under the platform bypass, and a token that matched two rows would
-- be a Chinese-wall breach decided by row order.
--
-- ## Tenancy is structural
--
-- Both tables denormalise `organization_id` and `grid_secure_table` checks only
-- that column, so every reference carries the organization inside its key
-- (the `document_roles` pattern, 0067): a row cannot claim this tenant while
-- pointing at another tenant's project or address. Both cascade from the
-- project, so a project purge (and the organization purge, which fans out to
-- one project purge per project) takes them along.
--
-- Listed in `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "inbound_mail_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  -- 12 characters of lowercase RFC 4648 base32, ~60 bits from crypto.randomBytes.
  "token" text NOT NULL,
  -- Frozen at mint time so the address a member copied keeps reading the same
  -- after the project is renamed. Empty when the name latinizes to nothing.
  "slug" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  CONSTRAINT "inbound_mail_addresses_token_shape"
    CHECK ("token" ~ '^[a-z2-7]{12}$'),
  -- No dots: the parser takes the substring after the LAST dot as the token.
  CONSTRAINT "inbound_mail_addresses_slug_shape"
    CHECK ("slug" ~ '^[a-z0-9-]{0,30}$'),
  CONSTRAINT "inbound_mail_addresses_revocation_attributed"
    CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "inbound_mail_addresses"
  ADD CONSTRAINT inbound_mail_addresses_project_id_organization_id_fkey
  FOREIGN KEY ("project_id", "organization_id")
  REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE;
--> statement-breakpoint
-- Referenceable with the project and organization inside the key, so a message
-- row cannot name this tenant while pointing at another tenant's address.
ALTER TABLE "inbound_mail_addresses"
  ADD CONSTRAINT inbound_mail_addresses_id_project_org_key UNIQUE ("id", "project_id", "organization_id");
--> statement-breakpoint
-- Global, not per organization: see the header.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_addresses_token"
  ON "inbound_mail_addresses" ("token");
--> statement-breakpoint
-- One active address per project. Lazy minting on first read can race; this is
-- what turns the loser into a 23505 the service answers by re-reading.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_addresses_active_project"
  ON "inbound_mail_addresses" ("project_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_addresses" IS
  'Project mail inbox addresses (<slug>.<token>@<domain>). Only the token resolves; a revoked token is the same as an unknown one. Tenant data.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_mail_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "address_id" uuid NOT NULL,
  -- sha256 hex of the normalized Message-ID and the sorted attachment digests
  -- (`deliveryKey` in lib/inbound-mail/mime.ts). Stable across redeliveries of
  -- one mail; different for a device that reuses Message-IDs.
  "delivery_key" text NOT NULL,
  -- The member the mail is filed AS. Known before the row exists: the webhook
  -- inserts only for a verified sender who is a member with write access.
  "sender_user_id" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  -- `E-Mail-Eingang/<this>`: date, time and sender, never the subject. Fixed
  -- at acceptance from `received_at`, so a re-run files into the same name.
  "folder_name" text NOT NULL,
  -- The folder the first filing attempt created. Every later attempt reuses
  -- it; nothing recomputes it. NULL again if somebody deletes the folder.
  "folder_id" uuid,
  -- For the one notification only; NULL once the row is terminal.
  "subject" text,
  -- The bucket the staged objects were written to (ADR-0043: recorded, never
  -- recomputed), and the objects themselves:
  -- [{ "key", "filename", "contentType", "sha256", "size" }].
  "staging_bucket" text,
  "staged" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- [{ "filename", "reason" }] while queued; reasons only once terminal.
  "skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "filed_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The drain attempt that owns the row while it is `processing`.
  "claim_token" uuid,
  -- A classification of the last failed attempt (an error name or a reason
  -- code), never a message: drizzle puts query parameters into those.
  "last_error" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The heartbeat: the drain touches it after each file it files.
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbound_mail_messages_status_known"
    CHECK ("status" IN ('queued', 'processing', 'filed', 'failed')),
  CONSTRAINT "inbound_mail_messages_delivery_key_shape"
    CHECK ("delivery_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "inbound_mail_messages_counts_non_negative"
    CHECK ("filed_count" >= 0 AND "skipped_count" >= 0 AND "attempts" >= 0),
  -- A claim token exists exactly while an attempt owns the row.
  CONSTRAINT "inbound_mail_messages_claimed_while_processing"
    CHECK (("status" = 'processing') = ("claim_token" IS NOT NULL)),
  CONSTRAINT "inbound_mail_messages_staged_is_array"
    CHECK (jsonb_typeof("staged") = 'array' AND jsonb_typeof("skipped") = 'array'),
  -- Staged objects need the bucket that holds them.
  CONSTRAINT "inbound_mail_messages_staging_bucket_known"
    CHECK ("staged" = '[]'::jsonb OR "staging_bucket" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "inbound_mail_messages"
  ADD CONSTRAINT inbound_mail_messages_project_id_organization_id_fkey
  FOREIGN KEY ("project_id", "organization_id")
  REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "inbound_mail_messages"
  ADD CONSTRAINT inbound_mail_messages_address_fkey
  FOREIGN KEY ("address_id", "project_id", "organization_id")
  REFERENCES "inbound_mail_addresses"("id", "project_id", "organization_id") ON DELETE CASCADE;
--> statement-breakpoint
-- The folder in the SAME project (and so the same organization, which the
-- project FK above pins): `project_folders` is keyed by (id, project_id) for
-- exactly this. SET NULL on the one column (Postgres 15+, as in 0043/0086): a
-- deleted folder makes the next attempt create a new one, and an unscoped SET
-- NULL would try to null `project_id` and fail its NOT NULL.
ALTER TABLE "inbound_mail_messages"
  ADD CONSTRAINT inbound_mail_messages_folder_fkey
  FOREIGN KEY ("folder_id", "project_id")
  REFERENCES "project_folders"("id", "project_id") ON DELETE SET NULL ("folder_id");
--> statement-breakpoint
-- Idempotency, keyed by ADDRESS and not by the mail alone: one mail CC'd to
-- projects in two organizations is two deliveries, and both must be filed.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_messages_address_delivery"
  ON "inbound_mail_messages" ("address_id", "delivery_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_messages_project_created_idx"
  ON "inbound_mail_messages" ("project_id", "created_at");
--> statement-breakpoint
-- The drain's claim: queued rows whose backoff has run out, oldest first.
CREATE INDEX IF NOT EXISTS "inbound_mail_messages_due_idx"
  ON "inbound_mail_messages" ("next_attempt_at") WHERE "status" = 'queued';
--> statement-breakpoint
-- The reaper: attempts whose heartbeat stopped.
CREATE INDEX IF NOT EXISTS "inbound_mail_messages_processing_idx"
  ON "inbound_mail_messages" ("updated_at") WHERE "status" = 'processing';
--> statement-breakpoint
-- The retention sweep (30 days) and the staging backstop (7 days).
CREATE INDEX IF NOT EXISTS "inbound_mail_messages_received_idx"
  ON "inbound_mail_messages" ("received_at");
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_messages" IS
  'One row per delivery to a project mail address: the durable queue the drain files from, and the idempotency record. Holds the staged attachments'' object keys and, until terminal, the subject and skipped names; never the mail. Deleted after 30 days. Tenant data.';
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_addresses', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_messages', 'organization_id = grid_current_org()');
