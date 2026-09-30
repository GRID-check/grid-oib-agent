-- 0101: inbound_mail_addresses + inbound_mail_messages — the project mail inbox.
--
-- ## Why
--
-- Every project gets an email address. A member mails files to it and the
-- attachments are filed into the project as if that member had uploaded them
-- (ADR-0074). Cloudflare Email Routing hands the raw message to one Worker,
-- which streams it to `POST /api/internal/inbound-mail`; these two tables are
-- everything the BFF keeps about that.
--
-- ## What the rows hold, and what they do not
--
-- No content. The mail is parsed in memory within the webhook request and
-- dropped; neither the body nor the raw message is stored anywhere. A message
-- row is a hash of the Message-ID (or of the raw bytes), the sender's WorkOS
-- user id, two counts, a status and timestamps. The files themselves are
-- ordinary documents and live and die with the documents' own lifecycle.
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
  -- sha256 hex of the Message-ID header, or of the raw bytes when it is missing.
  "message_id_hash" text NOT NULL,
  "sender_user_id" text,
  "status" text DEFAULT 'processing' NOT NULL,
  "filed_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbound_mail_messages_status_known"
    CHECK ("status" IN ('processing', 'filed', 'failed')),
  CONSTRAINT "inbound_mail_messages_hash_shape"
    CHECK ("message_id_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "inbound_mail_messages_counts_non_negative"
    CHECK ("filed_count" >= 0 AND "skipped_count" >= 0 AND "attempts" >= 1),
  -- A filed mail was filed AS somebody.
  CONSTRAINT "inbound_mail_messages_filed_attributed"
    CHECK ("status" <> 'filed' OR "sender_user_id" IS NOT NULL)
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
-- Idempotency, keyed by ADDRESS and not by Message-ID alone: one mail CC'd to
-- projects in two organizations is two deliveries, and both must be filed.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_messages_address_hash"
  ON "inbound_mail_messages" ("address_id", "message_id_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_messages_project_created_idx"
  ON "inbound_mail_messages" ("project_id", "created_at");
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_messages" IS
  'One row per delivery to a project mail address, for idempotency. Holds no content: a Message-ID hash, the sender user id, counts, status and timestamps. Tenant data.';
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_addresses', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_messages', 'organization_id = grid_current_org()');
