-- 0186: mail sent to a project waits until a person files it; a conversation is
-- one document; its originals are evidence; a person may follow it (ADR-0134).
--
-- ## What was missing
--
-- A project had no address. Correspondence reached it only when somebody saved
-- an attachment by hand, or imported a whole Outlook archive (ADR-0085). Now
-- every project has `<slug>.<token>@<domain>`, and anyone may write to it. That
-- is exactly why nothing that arrives becomes part of the project by itself:
-- a mail waits outside the project's documents (no `documents` row, no index
-- entry, nothing Piloti can answer from) until a person with write access files
-- each part. The text of a filed mail becomes a section of the conversation's
-- one document, the E-Mail-Verlauf, whose next Fassung each later message is.
--
-- ## Nine tables, one job each
--
--   inbound_mail_addresses         a project's address, and every address it had
--   inbound_mails                  one delivery: who sent it, how far it got, where it is staged
--   inbound_mail_parts             what a person can file: the mail's text or one attachment
--   inbound_mail_decisions         append-only: every act of a person on a part
--   mail_threads                   one conversation = one document of the project
--   mail_thread_entries            one filed message: the renderer's only input, and its original
--   mail_thread_entry_attachments  what came with a filed message, and which Fassung of which document it became
--   mail_thread_message_ids        the Message-IDs a thread received or was referred to by
--   mail_thread_follows            a person's standing decision to append a thread's later replies
--
-- ## No mail is filed without a person, and the database says who
--
-- A part is `filing` or `filed` exactly when it names a decision
-- (`inbound_mail_parts_decision_iff_filing`), through a composite key that
-- makes it a decision about THIS part, and a trigger requires that decision to
-- be a `file` (RT-S7). A decision's `decided_by` has the shape of a WorkOS user
-- id, so no `system:*` actor ever decides (`inbound_mail_decisions_decider_is_person`).
-- A Piloti card files clean, unflagged parts only (`..._piloti_cards_file_clean`).
-- A follow appends a message's text and nothing else (`..._follow_appends_text_only`,
-- and a trigger checks the part is the text), and the composite key to
-- `mail_thread_follows (id, thread_id, user_id)` makes the decider the follower.
-- A part is filed only when its scan was clean (`..._filed_is_clean`), and a
-- mail is shown only after its whole raw message was scanned
-- (`inbound_mails_waiting_is_scanned`). Each of these is a refused statement,
-- whichever code path tries.
--
-- ## Every key is a row's, under a reserved prefix
--
-- The staged objects live in the organization's bucket under the PROJECT prefix
-- (so the purger's prefix sweep takes them) in `_inbound-mail/<mail>/`: the raw
-- message, `read.json` (what the reader made of it) and one object per
-- attachment part, named by its position. A filed message's original is kept
-- at `_mail-originals/<entry>.eml`. CHECKs hold every key a row names to exactly
-- that shape under the row's own organization and project, and `lib/s3.ts`
-- reserves both segments, so no person's folder can take them. Erasure is by
-- the keys on the rows; only the project purge deletes by prefix. The bucket is
-- recorded before the first object is written (ADR-0043) and the purger reads
-- it from `inbound_mails.staging_bucket` and `mail_thread_entries.original_bucket`.
--
-- ## Ending is a state, never a tenant's DELETE
--
-- A part is dismissed or expires; a mail settles and is scrubbed to ids
-- (`inbound_mails_ended_is_scrubbed`); an address is revoked; a follow ends
-- with a reason; a thread loses its document. Rows are deleted only by the
-- retention sweeps and the project purge, which run as the platform role, so
-- DELETE is revoked from `grid_app_rw` on every table here but the
-- message-id index (which a detach rewrites). FK cascades run with the table
-- owner's rights, which a REVOKE does not touch, so a project purge still
-- cascades; a delete guard that tested `current_user` would see the owner there
-- and refuse the purge (docs/database/row-level-security.md, append-only tables).
--
-- A decision changes only once, when the audit trail takes it (`audited_at`
-- NULL to a time). It is deleted, by a sweep or a cascade, only after that,
-- unless its project is gone (the purge): a mail's decisions are the record of
-- who let what into the project (RT-S8).
--
-- ## Legal hold
--
-- A hold that covers the project stops the deletion of a mail, of a filed
-- message and of what came with it (`grid_legal_hold_blocks('project', …)`,
-- SQLSTATE GLH01, the 0093 backstop). Ending a part under a hold still ends it
-- for the person; the erasure of its bytes waits, and `erasure_deferred_at` is
-- the one way an ended part or mail may still name an object.
--
-- ## Tenancy is structural
--
-- Every table denormalises `organization_id`, and every reference carries the
-- organization or the project inside its key (the `document_roles` pattern,
-- 0067): a row cannot claim this tenant while pointing at another tenant's
-- project, address, mail, part, decision, thread, entry or follow. All of them
-- cascade from the project. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS; `scripts/rls-test-db.sh` proves each refusal.

CREATE TABLE IF NOT EXISTS "inbound_mail_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  -- 12 characters of lowercase RFC 4648 base32: 60 bits from the CSPRNG. Only
  -- the token resolves. It is stored as is because members read the address
  -- off the project page; it lets a sender put mail in front of a reviewer,
  -- never into the project, and a leaked one is rotated.
  "token" text NOT NULL,
  -- Frozen at mint time, so an address a member copied reads the same after a
  -- rename. No dots: the parser takes what follows the last dot as the token.
  "slug" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "revoked_reason" text,
  CONSTRAINT "inbound_mail_addresses_project_fkey"
    FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "inbound_mail_addresses_id_project_org_key" UNIQUE ("id", "project_id", "organization_id"),
  CONSTRAINT "inbound_mail_addresses_token_shape" CHECK ("token" ~ '^[a-z2-7]{12}$'),
  CONSTRAINT "inbound_mail_addresses_slug_shape" CHECK ("slug" ~ '^[a-z0-9-]{0,30}$'),
  CONSTRAINT "inbound_mail_addresses_revocation_attributed"
    CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL)
       AND ("revoked_at" IS NULL) = ("revoked_reason" IS NULL)),
  CONSTRAINT "inbound_mail_addresses_revoked_reason_known"
    CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('rotated', 'switched_off'))
);
--> statement-breakpoint
-- Global, revoked rows included: a token is never minted twice, so an old
-- address can never start to resolve to another project.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_addresses_token"
  ON "inbound_mail_addresses" ("token");
--> statement-breakpoint
-- One active address per project. Two lazy mints race into a 23505 the service
-- answers by reading the winner.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mail_addresses_active_project"
  ON "inbound_mail_addresses" ("project_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_addresses_project_created_idx"
  ON "inbound_mail_addresses" ("project_id", "created_at");
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_addresses" IS
  'Project mail addresses (<slug>.<token>@<domain>), the revoked ones included as rotation history until the project goes. Only the token resolves; a revoked token is the same as an unknown one and is never minted again. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  -- The E-Mail-Verlauf document. NULL while its first Fassung is being written,
  -- and again once the document is deleted: the retention sweep then deletes
  -- the thread, its entries and their originals (RT-S8).
  "document_id" uuid,
  -- RFC 5256 base subject, the thread's matching key and default name.
  "base_subject" text NOT NULL,
  -- Outlook's conversation GUID (PidTagConversationIndex), when a message had one.
  "thread_index_guid" uuid,
  -- Every domain that took part, ours excluded: a follow appends only replies
  -- whose every domain is already here (D31, condition 5).
  "participant_domains" text[] DEFAULT '{}'::text[] NOT NULL,
  -- The thread this one continues past the cap („Als Fortsetzung ablegen“).
  "continues_thread_id" uuid,
  "entry_count" integer DEFAULT 0 NOT NULL,
  "rendered_bytes" integer DEFAULT 0 NOT NULL,
  "last_entry_at" timestamp with time zone,
  -- An archive slice wrote entries that are not rendered yet (D33).
  "render_pending_at" timestamp with time zone,
  -- Who writes the thread's next Fassung now, and until when. Fassung N+1
  -- must hold every section of Fassung N (the superset invariant), so two
  -- appends may not render and upload side by side: the later upload of the
  -- smaller set would drop the other's section. Every writer of a Fassung (a
  -- filing, a follow, a detach, an archive render) takes this lease with a
  -- compare-and-set, renders and uploads under it, and lets it go; a writer
  -- that died leaves it to run out (`lib/mail-thread/append.ts`). A
  -- transaction cannot hold it: the upload is object storage and HTTP, and a
  -- pooled connection (PgBouncer, ADR-0083) keeps no session lock.
  "render_lease_holder" uuid,
  "render_lease_until" timestamp with time zone,
  -- The one locale the rendition's words are in, for the thread's life: Fassung
  -- N+1 repeats every section of Fassung N byte for byte.
  "locale" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mail_threads_project_fkey"
    FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "mail_threads_id_project_org_key" UNIQUE ("id", "project_id", "organization_id"),
  -- The document in the SAME project; SET NULL on the one column (PostgreSQL
  -- 15+, as in 0043): an unscoped SET NULL would try to null `project_id`.
  CONSTRAINT "mail_threads_document_fkey"
    FOREIGN KEY ("document_id", "project_id")
    REFERENCES "documents"("id", "project_id") ON DELETE SET NULL ("document_id"),
  CONSTRAINT "mail_threads_continues_fkey"
    FOREIGN KEY ("continues_thread_id", "project_id", "organization_id")
    REFERENCES "mail_threads"("id", "project_id", "organization_id") ON DELETE SET NULL ("continues_thread_id"),
  CONSTRAINT "mail_threads_continues_another" CHECK ("continues_thread_id" <> "id"),
  CONSTRAINT "mail_threads_base_subject_length" CHECK (char_length("base_subject") <= 500),
  CONSTRAINT "mail_threads_participant_domains_bounded" CHECK (cardinality("participant_domains") <= 200),
  CONSTRAINT "mail_threads_entry_count_bounded" CHECK ("entry_count" BETWEEN 0 AND 200),
  CONSTRAINT "mail_threads_rendered_bytes_bounded" CHECK ("rendered_bytes" BETWEEN 0 AND 2097152),
  CONSTRAINT "mail_threads_locale_known" CHECK ("locale" IN ('de', 'en')),
  CONSTRAINT "mail_threads_creator_is_person" CHECK ("created_by" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "mail_threads_render_lease_together"
    CHECK (("render_lease_holder" IS NULL) = ("render_lease_until" IS NULL))
);
--> statement-breakpoint
-- A document is the Verlauf of one thread at most.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mail_threads_document"
  ON "mail_threads" ("document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_threads_thread_index_idx"
  ON "mail_threads" ("project_id", "thread_index_guid") WHERE "thread_index_guid" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_threads_base_subject_idx"
  ON "mail_threads" ("project_id", "base_subject");
--> statement-breakpoint
-- Sweep 9: threads whose document is gone.
CREATE INDEX IF NOT EXISTS "mail_threads_without_document_idx"
  ON "mail_threads" ("created_at") WHERE "document_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_threads_render_pending_idx"
  ON "mail_threads" ("render_pending_at") WHERE "render_pending_at" IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE "mail_threads" IS
  'An E-Mail-Verlauf: one mail conversation filed as one document of the project, whose next Fassung each later filed message is. Holds no message text; its entries do. Deleted with its entries once its document is gone. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_thread_follows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  -- The follower: every append this follow makes is filed as them.
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "renewed_at" timestamp with time zone,
  "daily_cap" smallint DEFAULT 20 NOT NULL,
  -- Day 55: `mail_thread.follow_expiring`, once.
  "expiring_notified_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  -- The person who ended it; NULL when the system noticed (expiry, lost
  -- access, a rotated address, a detach, the document gone).
  "ended_by" text,
  "ended_reason" text,
  CONSTRAINT "mail_thread_follows_thread_fkey"
    FOREIGN KEY ("thread_id", "project_id", "organization_id")
    REFERENCES "mail_threads"("id", "project_id", "organization_id") ON DELETE CASCADE,
  -- What a follow decision's composite key points at.
  CONSTRAINT "mail_thread_follows_decision_key" UNIQUE ("id", "thread_id", "user_id", "organization_id"),
  CONSTRAINT "mail_thread_follows_follower_is_person" CHECK ("user_id" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "mail_thread_follows_window"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '180 days'),
  CONSTRAINT "mail_thread_follows_renewed_after_start"
    CHECK ("renewed_at" IS NULL OR "renewed_at" >= "created_at"),
  CONSTRAINT "mail_thread_follows_daily_cap_bounded" CHECK ("daily_cap" BETWEEN 1 AND 50),
  CONSTRAINT "mail_thread_follows_ended_with_reason"
    CHECK (("ended_at" IS NULL) = ("ended_reason" IS NULL)
       AND ("ended_by" IS NULL OR "ended_at" IS NOT NULL)),
  CONSTRAINT "mail_thread_follows_ended_reason_known"
    CHECK ("ended_reason" IS NULL OR "ended_reason" IN
      ('unfollowed', 'expired', 'access_lost', 'address_rotated', 'detached', 'document_gone', 'revoked_by_manager')),
  -- The follower ends their own follow; a manager ends someone else's.
  CONSTRAINT "mail_thread_follows_ended_by_person"
    CHECK ("ended_by" IS NULL OR "ended_by" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "mail_thread_follows_person_reason_attributed"
    CHECK (("ended_reason" IS DISTINCT FROM 'unfollowed' OR "ended_by" IS NOT DISTINCT FROM "user_id")
       AND ("ended_reason" IS DISTINCT FROM 'revoked_by_manager'
            OR ("ended_by" IS NOT NULL AND "ended_by" <> "user_id")))
);
--> statement-breakpoint
-- One active follow per person and thread. Several people may follow one
-- thread; an append happens once, as the earliest active follower.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mail_thread_follows_active"
  ON "mail_thread_follows" ("thread_id", "user_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
-- Sweep 12: follows that ran out.
CREATE INDEX IF NOT EXISTS "mail_thread_follows_expiry_idx"
  ON "mail_thread_follows" ("expires_at") WHERE "ended_at" IS NULL;
--> statement-breakpoint
COMMENT ON TABLE "mail_thread_follows" IS
  'A person''s standing decision to append the text of a thread''s later verified replies as themselves (D31): 60 days by default, at most 180, capped per day, ended with a reason. Never deleted by a tenant session. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_thread_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "source" text NOT NULL,
  -- Provenance only, no foreign key: the mail row is deleted after its keep,
  -- the import's after its own; the entry outlives both.
  "inbound_mail_id" uuid,
  "mail_import_id" uuid,
  "message_id" text,
  -- Clamped to [received_at - 30 days, received_at] (D11).
  "sent_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  -- The section heading as rendered; it never changes, so citations hold.
  "heading" text NOT NULL,
  "in_reply_to_entry_id" uuid,
  "sender_address" text,
  "sender_name" text,
  "sender_domain" text,
  "signer_domain" text,
  "sender_trust" text NOT NULL,
  "authentication_results" text,
  "participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "own_text" text DEFAULT '' NOT NULL,
  -- Set when the person chose „Unkenntlich ablegen“ (D13); NULL is unmasked.
  "masked_spans" jsonb,
  "quoted" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "calendar" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- The Fassung the message first appeared in.
  "first_version_id" uuid,
  "filed_by" text NOT NULL,
  "filed_via" text NOT NULL,
  "filed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The original `.eml` (D6): evidence, never a document, never read by a model.
  "original_bucket" text,
  "original_storage_key" text,
  "original_sha256" text,
  "original_bytes" bigint,
  "original_scan_status" text,
  "original_scanned_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mail_thread_entries_thread_fkey"
    FOREIGN KEY ("thread_id", "project_id", "organization_id")
    REFERENCES "mail_threads"("id", "project_id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "mail_thread_entries_id_project_org_key" UNIQUE ("id", "project_id", "organization_id"),
  -- What a message id's composite key points at, so an entry's ids move with it.
  CONSTRAINT "mail_thread_entries_id_thread_key" UNIQUE ("id", "thread_id"),
  CONSTRAINT "mail_thread_entries_heading_key" UNIQUE ("thread_id", "heading"),
  CONSTRAINT "mail_thread_entries_in_reply_to_fkey"
    FOREIGN KEY ("in_reply_to_entry_id", "project_id", "organization_id")
    REFERENCES "mail_thread_entries"("id", "project_id", "organization_id") ON DELETE SET NULL ("in_reply_to_entry_id"),
  CONSTRAINT "mail_thread_entries_first_version_fkey"
    FOREIGN KEY ("first_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL,
  CONSTRAINT "mail_thread_entries_source_known" CHECK ("source" IN ('inbound', 'archive')),
  CONSTRAINT "mail_thread_entries_provenance"
    CHECK (("source" = 'inbound') = ("inbound_mail_id" IS NOT NULL)
       AND ("source" = 'archive') = ("mail_import_id" IS NOT NULL)),
  CONSTRAINT "mail_thread_entries_sender_trust_known"
    CHECK ("sender_trust" IN ('member_verified', 'member_unverified', 'external_verified', 'external_unverified', 'not_checked')),
  -- The archive claims nothing; every inbound message was checked.
  CONSTRAINT "mail_thread_entries_archive_not_checked"
    CHECK (("source" = 'archive') = ("sender_trust" = 'not_checked')),
  CONSTRAINT "mail_thread_entries_filed_via_known"
    CHECK ("filed_via" IN ('app', 'agent', 'piloti_proposal', 'follow', 'archive_import')),
  CONSTRAINT "mail_thread_entries_archive_imported"
    CHECK (("source" = 'archive') = ("filed_via" = 'archive_import')),
  CONSTRAINT "mail_thread_entries_filer_is_person" CHECK ("filed_by" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "mail_thread_entries_heading_length" CHECK (char_length("heading") BETWEEN 1 AND 500),
  CONSTRAINT "mail_thread_entries_message_id_length"
    CHECK ("message_id" IS NULL OR char_length("message_id") BETWEEN 1 AND 998),
  CONSTRAINT "mail_thread_entries_sender_lengths"
    CHECK (("sender_address" IS NULL OR char_length("sender_address") <= 320)
       AND ("sender_name" IS NULL OR char_length("sender_name") <= 300)
       AND ("sender_domain" IS NULL OR char_length("sender_domain") <= 253)
       AND ("signer_domain" IS NULL OR char_length("signer_domain") <= 253)),
  -- Built from DKIM and DMARC only (RT-S18): mailauth's own line says spf=temperror.
  CONSTRAINT "mail_thread_entries_authentication_results_shape"
    CHECK ("authentication_results" IS NULL
       OR (char_length("authentication_results") <= 4096
           AND position('spf=' IN lower("authentication_results")) = 0)),
  CONSTRAINT "mail_thread_entries_own_text_bounded" CHECK (octet_length("own_text") <= 524288),
  CONSTRAINT "mail_thread_entries_json_shapes"
    CHECK (jsonb_typeof("participants") = 'array' AND jsonb_array_length("participants") <= 50
       AND ("masked_spans" IS NULL
            OR (jsonb_typeof("masked_spans") = 'array' AND jsonb_array_length("masked_spans") <= 1000))
       AND jsonb_typeof("quoted") = 'array' AND jsonb_array_length("quoted") <= 50
       AND jsonb_typeof("calendar") = 'array' AND jsonb_array_length("calendar") <= 20),
  -- An archive entry has no original: the import never had the message's bytes.
  CONSTRAINT "mail_thread_entries_archive_has_no_original"
    CHECK (("source" = 'archive') <= ("original_storage_key" IS NULL)),
  CONSTRAINT "mail_thread_entries_original_together"
    CHECK (("original_storage_key" IS NULL) = ("original_bucket" IS NULL)
       AND ("original_storage_key" IS NULL) = ("original_sha256" IS NULL)
       AND ("original_storage_key" IS NULL) = ("original_bytes" IS NULL)
       AND ("original_storage_key" IS NULL) = ("original_scan_status" IS NULL)),
  CONSTRAINT "mail_thread_entries_original_key_shape"
    CHECK ("original_storage_key" IS NULL
       OR "original_storage_key" = 'org/' || "organization_id" || '/project/' || "project_id"::text
                                   || '/_mail-originals/' || "id"::text || '.eml'),
  CONSTRAINT "mail_thread_entries_original_sha256_shape"
    CHECK ("original_sha256" IS NULL OR "original_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mail_thread_entries_original_bytes_bounded"
    CHECK ("original_bytes" IS NULL OR "original_bytes" BETWEEN 0 AND 27262976),
  CONSTRAINT "mail_thread_entries_original_scan_known"
    CHECK ("original_scan_status" IS NULL OR "original_scan_status" IN ('pending', 'clean', 'infected', 'failed')),
  CONSTRAINT "mail_thread_entries_original_scanned_at"
    CHECK ("original_scanned_at" IS NULL OR coalesce("original_scan_status", '') IN ('clean', 'infected', 'failed'))
);
--> statement-breakpoint
-- Dedupe by Message-ID across the project. Not unique: a forger can take a
-- genuine id first, and the genuine message must still file (RT-S1).
CREATE INDEX IF NOT EXISTS "mail_thread_entries_message_id_idx"
  ON "mail_thread_entries" ("project_id", "message_id") WHERE "message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_entries_thread_sent_idx"
  ON "mail_thread_entries" ("thread_id", "sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_entries_inbound_mail_idx"
  ON "mail_thread_entries" ("inbound_mail_id") WHERE "inbound_mail_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_entries_mail_import_idx"
  ON "mail_thread_entries" ("mail_import_id") WHERE "mail_import_id" IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE "mail_thread_entries" IS
  'One filed message of an E-Mail-Verlauf, from the project address or an Outlook archive: the renderer''s only input, and, for inbound mail, the key of its original .eml (evidence: never indexed, never read by a model). Lives as long as the thread document. Tenant data (migration 0186).';
--> statement-breakpoint
-- D36: the attachment and its mail know each other, per Fassung. One row per
-- attachment the message carried, written when the message is filed (inbound)
-- or imported (archive), whatever became of it: filed as a document, already
-- in the project as these bytes, or not filed (dismissed, blocked, not
-- accepted: then its bytes live only in the original). So a thread names what
-- came with each message, and a document names the mails that brought each of
-- its Fassungen (`document-get`, `document-version-list` `mailOrigins`).
CREATE TABLE IF NOT EXISTS "mail_thread_entry_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "entry_id" uuid NOT NULL,
  -- The part's position in the mail (`inbound_mail_parts.position`); a file
  -- that was never staged follows the staged ones.
  "position" integer NOT NULL,
  -- The name as it arrived, kept as the mail's own record of what it carried;
  -- NULL for a file that came without one. Shown only to a reader who may see
  -- the document it became (`mail-thread-get`).
  "filename" text,
  "disposition" text NOT NULL,
  "not_filed_reason" text,
  -- The document and the Fassung this attachment became (`filed`) or already
  -- was (`already_present`). The live half of the link: SET NULL when either
  -- goes, the row stays and says the attachment came.
  "document_id" uuid,
  "document_version_id" uuid,
  -- What the thread's section prints for it, frozen at insert: the superset
  -- invariant forbids a later Fassung to rename or newly name an attachment in
  -- an earlier section (`lib/mail-thread/render.ts`). NULL is counted, never
  -- named: not filed, filed into a folder less visible than the thread, or a
  -- name the Namensprüfung stopped (RT-S13).
  "section_name" text,
  "section_folder_path" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mail_thread_entry_attachments_entry_fkey"
    FOREIGN KEY ("entry_id", "project_id", "organization_id")
    REFERENCES "mail_thread_entries"("id", "project_id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "mail_thread_entry_attachments_entry_position_key" UNIQUE ("entry_id", "position"),
  -- The document in the SAME project; SET NULL on the one column.
  CONSTRAINT "mail_thread_entry_attachments_document_fkey"
    FOREIGN KEY ("document_id", "project_id")
    REFERENCES "documents"("id", "project_id") ON DELETE SET NULL ("document_id"),
  -- The Fassung belongs to THAT document.
  CONSTRAINT "mail_thread_entry_attachments_version_fkey"
    FOREIGN KEY ("document_version_id", "document_id")
    REFERENCES "document_versions"("id", "document_id") ON DELETE SET NULL ("document_version_id"),
  CONSTRAINT "mail_thread_entry_attachments_position_non_negative" CHECK ("position" >= 0),
  CONSTRAINT "mail_thread_entry_attachments_disposition_known"
    CHECK ("disposition" IN ('filed', 'already_present', 'not_filed')),
  CONSTRAINT "mail_thread_entry_attachments_reason_iff_not_filed"
    CHECK (("disposition" = 'not_filed') = ("not_filed_reason" IS NOT NULL)),
  CONSTRAINT "mail_thread_entry_attachments_reason_known"
    CHECK ("not_filed_reason" IS NULL OR "not_filed_reason" IN
      ('pending', 'dismissed', 'expired', 'infected', 'scan_failed', 'type_not_accepted', 'encrypted', 'archive',
       'size', 'limit', 'empty', 'screened', 'access', 'name_taken', 'unreadable')),
  -- A file not filed is no document's.
  CONSTRAINT "mail_thread_entry_attachments_not_filed_has_no_document"
    CHECK ("disposition" <> 'not_filed' OR ("document_id" IS NULL AND "document_version_id" IS NULL)),
  CONSTRAINT "mail_thread_entry_attachments_filename_length"
    CHECK ("filename" IS NULL OR char_length("filename") BETWEEN 1 AND 500),
  -- Only a file that is a document is named, and a folder only with a name.
  CONSTRAINT "mail_thread_entry_attachments_section_named_when_filed"
    CHECK ("section_name" IS NULL OR ("disposition" <> 'not_filed' AND char_length("section_name") BETWEEN 1 AND 500)),
  CONSTRAINT "mail_thread_entry_attachments_section_folder_with_name"
    CHECK ("section_folder_path" IS NULL
       OR ("section_name" IS NOT NULL AND char_length("section_folder_path") <= 1000))
);
--> statement-breakpoint
-- „Which mail brought this Fassung“: the document routes' `mailOrigins`.
CREATE INDEX IF NOT EXISTS "mail_thread_entry_attachments_document_idx"
  ON "mail_thread_entry_attachments" ("document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_entry_attachments_version_idx"
  ON "mail_thread_entry_attachments" ("document_version_id") WHERE "document_version_id" IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE "mail_thread_entry_attachments" IS
  'What came with a filed message (D36), one row per attachment, and what became of it: the document and Fassung it is, or why it was not filed (its bytes then live only in the original). What the thread''s section prints for it is frozen at insert. Lives as long as its entry. Tenant data (migration 0186).';
--> statement-breakpoint
-- What a row may still learn after its insert, and nothing else (the
-- superset invariant keeps the section's words; the trail keeps the rest):
--
--   * its document or Fassung going (the keys' SET NULL; a Fassung goes with
--     its document: once `document_id` is NULL the composite key to the
--     version is no longer checked, and its SET NULL would never fire, so the
--     guard nulls the version itself), and
--   * an attachment that still waited when its message was filed (`pending`)
--     being decided later: filed (with its document and Fassung), already
--     present, or not filed for good (dismissed, expired, ...). Once.
CREATE OR REPLACE FUNCTION grid_mail_thread_entry_attachments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  keeps constant text[] := ARRAY['document_id', 'document_version_id', 'disposition', 'not_filed_reason'];
  was_pending boolean;
BEGIN
  was_pending := OLD.disposition = 'not_filed' AND OLD.not_filed_reason = 'pending';
  IF NEW.document_id IS NULL THEN
    NEW.document_version_id := NULL;
  END IF;
  IF (to_jsonb(NEW) - keeps) IS DISTINCT FROM (to_jsonb(OLD) - keeps) THEN
    RAISE EXCEPTION 'what came with a filed message is never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mail_thread_entry_attachments_frozen',
            TABLE = 'mail_thread_entry_attachments';
  END IF;
  IF NOT was_pending AND (
       NEW.disposition IS DISTINCT FROM OLD.disposition
       OR NEW.not_filed_reason IS DISTINCT FROM OLD.not_filed_reason
       OR (NEW.document_id IS DISTINCT FROM OLD.document_id AND NEW.document_id IS NOT NULL)
       OR (NEW.document_version_id IS DISTINCT FROM OLD.document_version_id AND NEW.document_version_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'only an attachment that still waited is decided later, and only once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mail_thread_entry_attachments_decided_once',
            TABLE = 'mail_thread_entry_attachments';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entry_attachments_guard" ON "mail_thread_entry_attachments";
--> statement-breakpoint
CREATE TRIGGER "mail_thread_entry_attachments_guard"
  BEFORE UPDATE ON "mail_thread_entry_attachments"
  FOR EACH ROW EXECUTE FUNCTION grid_mail_thread_entry_attachments_guard();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_thread_message_ids" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  -- Normalized: no angle brackets, the domain part lowercased.
  "message_id" text NOT NULL,
  "state" text NOT NULL,
  -- The entry that received it, or that named it as a reference.
  "entry_id" uuid,
  CONSTRAINT "mail_thread_message_ids_thread_fkey"
    FOREIGN KEY ("thread_id", "project_id", "organization_id")
    REFERENCES "mail_threads"("id", "project_id", "organization_id") ON DELETE CASCADE,
  -- An entry's ids sit in the entry's thread, and move with it on a detach.
  CONSTRAINT "mail_thread_message_ids_entry_fkey"
    FOREIGN KEY ("entry_id", "thread_id")
    REFERENCES "mail_thread_entries"("id", "thread_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mail_thread_message_ids_state_known" CHECK ("state" IN ('received', 'referenced')),
  -- Received ids are keyed by entry: a Message-ID received twice (a forger
  -- first, RT-S1) is two rows, and neither blocks the other.
  CONSTRAINT "mail_thread_message_ids_received_by_entry"
    CHECK ("state" <> 'received' OR "entry_id" IS NOT NULL),
  CONSTRAINT "mail_thread_message_ids_length" CHECK (char_length("message_id") BETWEEN 1 AND 998),
  CONSTRAINT "mail_thread_message_ids_key"
    UNIQUE NULLS NOT DISTINCT ("thread_id", "message_id", "state", "entry_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_message_ids_lookup_idx"
  ON "mail_thread_message_ids" ("project_id", "message_id");
--> statement-breakpoint
COMMENT ON TABLE "mail_thread_message_ids" IS
  'The Message-IDs a mail thread received (one row per entry) or was referred to by, for matching a later reply to its thread. Opaque identifiers only. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_mails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "address_id" uuid NOT NULL,
  "status" text DEFAULT 'receiving' NOT NULL,
  -- sha256 hex of the raw message: a redelivery is the same key, and a replay
  -- of a signed request is a duplicate rather than a second mail. Message-ID
  -- is only a hint, forgeable and sometimes absent.
  "delivery_key" text,
  -- The SMTP MAIL FROM; '' is the null sender of a bounce.
  "envelope_from" text,
  "raw_size_bytes" bigint,
  -- ADR-0043: recorded when the row is inserted, before any object is written.
  "staging_bucket" text NOT NULL,
  "raw_storage_key" text,
  "read_storage_key" text,
  -- The raw message is scanned whole before the mail is shown (D16).
  "raw_scan_status" text DEFAULT 'pending' NOT NULL,
  "raw_scan_engine" text,
  "raw_scan_signature" text,
  "raw_scanned_at" timestamp with time zone,
  "raw_scan_attempts" smallint DEFAULT 0 NOT NULL,
  -- Thread identity, normalized and opaque; kept after the mail settles, since
  -- a later reply finds its thread through them.
  "message_id" text,
  "in_reply_to" text[] DEFAULT '{}'::text[] NOT NULL,
  "reference_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "thread_index_guid" uuid,
  "base_subject" text,
  -- [{ threadId, strength, headers }]: ids and strengths only. Candidates are
  -- computed for the viewer at read time, never stored (D9, RT-S13).
  "thread_match" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- What a reviewer needs to decide; gone once the mail settles.
  "sender_address" text,
  "sender_name" text,
  "subject" text,
  -- [{ role, name, address }]: From, Reply-To, To and Cc, the project
  -- addresses taken out (B8).
  "participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "participant_domains" text[] DEFAULT '{}'::text[] NOT NULL,
  "recipient_count" integer DEFAULT 0 NOT NULL,
  -- The verdict (D4): a label and a condition on defaults, never a gate.
  -- NULL until the receive job read the mail.
  "sender_trust" text,
  -- The member the sender address belongs to; read only under D9's notice rules.
  "sender_user_id" text,
  "sender_reason" text,
  "signer_domain" text,
  -- mailauth's signingHeaders.keys of the aligned passing signature, lowercase.
  "signed_headers" text[] DEFAULT '{}'::text[] NOT NULL,
  "sender_flags" text[] DEFAULT '{}'::text[] NOT NULL,
  -- Our own RFC 8601 line from DKIM and DMARC only.
  "authentication_results" text,
  -- List, bulk or auto-generated mail: held, announced collapsed, no model spend.
  "automatic" boolean DEFAULT false NOT NULL,
  "dropped_reason" text,
  -- `sent_at` is the clamped Date, `sent_at_header` the sender's claim.
  "sent_at" timestamp with time zone,
  "sent_at_header" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Fixed at receipt, so a later change of the window never moves a mail.
  "expires_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone,
  "notified_at" timestamp with time zone,
  "expiring_notified_at" timestamp with time zone,
  -- [{ filename, reason }] while waiting; counts by reason in `ignored` after.
  "not_staged" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ignored" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- A hold stopped the erasure of the staged objects; the sweep retries after release.
  "erasure_deferred_at" timestamp with time zone,
  -- The raw message is being moved to a filed entry's original; the filing
  -- job clears it, and a sweep finishes a move that stopped half-way.
  "original_move_pending_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbound_mails_project_fkey"
    FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE,
  -- NO ACTION, not CASCADE: an address is revoked, never deleted, while a mail
  -- names it, so deleting one cannot erase mail behind the REVOKE below. The
  -- project purge removes both in one statement, which NO ACTION allows.
  CONSTRAINT "inbound_mails_address_fkey"
    FOREIGN KEY ("address_id", "project_id", "organization_id")
    REFERENCES "inbound_mail_addresses"("id", "project_id", "organization_id"),
  CONSTRAINT "inbound_mails_id_project_org_key" UNIQUE ("id", "project_id", "organization_id"),
  CONSTRAINT "inbound_mails_status_known"
    CHECK ("status" IN ('receiving', 'received', 'waiting', 'settled', 'dropped')),
  CONSTRAINT "inbound_mails_delivery_key_shape"
    CHECK ("delivery_key" IS NULL OR "delivery_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "inbound_mails_delivery_key_when_received"
    CHECK ("status" = 'receiving' OR "delivery_key" IS NOT NULL),
  CONSTRAINT "inbound_mails_envelope_from_length"
    CHECK ("envelope_from" IS NULL OR char_length("envelope_from") <= 320),
  CONSTRAINT "inbound_mails_raw_size_bounded"
    CHECK ("raw_size_bytes" IS NULL OR "raw_size_bytes" BETWEEN 0 AND 27262976),
  CONSTRAINT "inbound_mails_raw_size_when_received"
    CHECK ("status" = 'receiving' OR "raw_size_bytes" IS NOT NULL),
  -- Every key is this row's own, under the reserved staging prefix.
  CONSTRAINT "inbound_mails_staging_keys_shape"
    CHECK (("raw_storage_key" IS NULL
            OR "raw_storage_key" = 'org/' || "organization_id" || '/project/' || "project_id"::text
                                   || '/_inbound-mail/' || "id"::text || '/raw.eml')
       AND ("read_storage_key" IS NULL
            OR "read_storage_key" = 'org/' || "organization_id" || '/project/' || "project_id"::text
                                    || '/_inbound-mail/' || "id"::text || '/read.json')),
  -- The receive job reads the raw message; it is there until the job has run.
  CONSTRAINT "inbound_mails_raw_while_received"
    CHECK ("status" <> 'received' OR "raw_storage_key" IS NOT NULL),
  CONSTRAINT "inbound_mails_raw_scan_known"
    CHECK ("raw_scan_status" IN ('pending', 'clean', 'infected', 'failed')),
  -- Nobody is shown a mail whose raw message was not scanned (D16, RT-S3).
  CONSTRAINT "inbound_mails_waiting_is_scanned"
    CHECK ("status" <> 'waiting' OR "raw_scan_status" IN ('clean', 'infected', 'failed')),
  CONSTRAINT "inbound_mails_raw_scanned_at"
    CHECK (("raw_scan_status" = 'pending') = ("raw_scanned_at" IS NULL)),
  CONSTRAINT "inbound_mails_raw_scan_signature_when_infected"
    CHECK ("raw_scan_signature" IS NULL OR "raw_scan_status" = 'infected'),
  CONSTRAINT "inbound_mails_raw_scan_attempts_bounded" CHECK ("raw_scan_attempts" BETWEEN 0 AND 100),
  CONSTRAINT "inbound_mails_identifiers_bounded"
    CHECK (("message_id" IS NULL OR char_length("message_id") BETWEEN 1 AND 998)
       AND cardinality("in_reply_to") <= 5
       AND cardinality("reference_ids") <= 50
       AND ("base_subject" IS NULL OR char_length("base_subject") <= 500)),
  CONSTRAINT "inbound_mails_thread_match_bounded"
    CHECK (jsonb_typeof("thread_match") = 'array' AND jsonb_array_length("thread_match") <= 50),
  CONSTRAINT "inbound_mails_sender_lengths"
    CHECK (("sender_address" IS NULL OR char_length("sender_address") BETWEEN 1 AND 320)
       AND ("sender_name" IS NULL OR char_length("sender_name") <= 300)
       AND ("subject" IS NULL OR char_length("subject") <= 998)
       AND ("signer_domain" IS NULL OR char_length("signer_domain") <= 253)),
  CONSTRAINT "inbound_mails_recipients_bounded"
    CHECK ("recipient_count" BETWEEN 0 AND 1000
       AND jsonb_typeof("participants") = 'array' AND jsonb_array_length("participants") <= 200
       AND cardinality("participant_domains") <= 50),
  -- Every mail a person sees was checked; a dropped one may never have been.
  CONSTRAINT "inbound_mails_trust_when_shown"
    CHECK ("status" NOT IN ('waiting', 'settled') OR "sender_trust" IS NOT NULL),
  CONSTRAINT "inbound_mails_sender_trust_known"
    CHECK ("sender_trust" IS NULL
       OR "sender_trust" IN ('member_verified', 'member_unverified', 'external_verified', 'external_unverified')),
  -- A member is named exactly when the From address is a member's, verified or not.
  CONSTRAINT "inbound_mails_member_has_user"
    CHECK ((coalesce("sender_trust", '') LIKE 'member\_%') = ("sender_user_id" IS NOT NULL)),
  CONSTRAINT "inbound_mails_sender_reason_known"
    CHECK ("sender_reason" IS NULL OR "sender_reason" IN
      ('dkim_pass', 'header_malformed', 'header_duplicate', 'from_count', 'from_not_ascii', 'dkim_too_many',
       'dkim_body_length', 'dkim_testing', 'dkim_expired', 'dkim_unsigned_fields', 'dkim_weak_algorithm',
       'dkim_short_key', 'dkim_temperror', 'dkim_fail', 'dkim_policy', 'dkim_permerror', 'dkim_unaligned',
       'dkim_none', 'verifier_timeout', 'verifier_error')),
  -- Every verdict says why, and only an aligned DKIM pass is verified.
  CONSTRAINT "inbound_mails_reason_with_trust"
    CHECK (("sender_trust" IS NULL) = ("sender_reason" IS NULL)
       AND ("sender_reason" IS NULL
            OR ("sender_reason" = 'dkim_pass') = ("sender_trust" IN ('member_verified', 'external_verified')))),
  CONSTRAINT "inbound_mails_sender_user_is_person"
    CHECK ("sender_user_id" IS NULL OR "sender_user_id" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "inbound_mails_signed_headers_shape"
    CHECK (cardinality("signed_headers") <= 64
       AND array_to_string("signed_headers", ',') ~ '^([a-z0-9-]+(,[a-z0-9-]+)*)?$'),
  CONSTRAINT "inbound_mails_sender_flags_known"
    CHECK ("sender_flags" <@ ARRAY['not_addressed_to_project', 'bcc_own', 'stale_date',
                                   'date_out_of_range', 'message_id_reused', 'already_filed']::text[]),
  -- A member's own Bcc copy is the exception to `not_addressed_to_project`,
  -- never a flag of its own: forgetting the exception then errs safe.
  CONSTRAINT "inbound_mails_bcc_own_paired"
    CHECK (NOT ('bcc_own' = ANY ("sender_flags"))
       OR ('not_addressed_to_project' = ANY ("sender_flags") AND "sender_trust" = 'member_verified')),
  CONSTRAINT "inbound_mails_authentication_results_shape"
    CHECK ("authentication_results" IS NULL
       OR (char_length("authentication_results") <= 4096
           AND position('spf=' IN lower("authentication_results")) = 0)),
  CONSTRAINT "inbound_mails_dropped_reason_known"
    CHECK ("dropped_reason" IS NULL OR "dropped_reason" IN ('auto_reply', 'delivery_report', 'self_loop')),
  CONSTRAINT "inbound_mails_dropped_with_reason"
    CHECK (("status" = 'dropped') = ("dropped_reason" IS NOT NULL)),
  CONSTRAINT "inbound_mails_expires_after_received" CHECK ("expires_at" > "received_at"),
  CONSTRAINT "inbound_mails_settled_at" CHECK (("status" = 'settled') = ("settled_at" IS NOT NULL)),
  -- Someone has to be shown who wrote.
  CONSTRAINT "inbound_mails_sender_while_open"
    CHECK ("status" <> 'waiting' OR "sender_address" IS NOT NULL),
  -- The scrub, as a constraint: nothing that names a third party or a file
  -- survives the end of a mail, whichever code path ended it. The staged
  -- objects are gone too, unless a hold deferred their erasure or the raw
  -- message is on its way to a filed entry's original.
  CONSTRAINT "inbound_mails_ended_is_scrubbed"
    CHECK ("status" NOT IN ('settled', 'dropped') OR (
      "sender_address" IS NULL AND "sender_name" IS NULL AND "subject" IS NULL
      AND "base_subject" IS NULL AND "envelope_from" IS NULL
      AND "participants" = '[]'::jsonb AND "participant_domains" = '{}'::text[]
      AND "not_staged" = '[]'::jsonb
      AND ("raw_storage_key" IS NULL OR "erasure_deferred_at" IS NOT NULL OR "original_move_pending_at" IS NOT NULL)
      AND ("read_storage_key" IS NULL OR "erasure_deferred_at" IS NOT NULL))),
  CONSTRAINT "inbound_mails_not_staged_bounded"
    CHECK (jsonb_typeof("not_staged") = 'array' AND jsonb_array_length("not_staged") <= 100),
  CONSTRAINT "inbound_mails_ignored_object" CHECK (jsonb_typeof("ignored") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbound_mails_address_delivery"
  ON "inbound_mails" ("address_id", "delivery_key");
--> statement-breakpoint
-- The E-Mail-Eingang: what waits, for one project or all of them.
CREATE INDEX IF NOT EXISTS "inbound_mails_waiting_idx"
  ON "inbound_mails" ("organization_id", "project_id", "received_at") WHERE "status" = 'waiting';
--> statement-breakpoint
-- Sweeps 3 and 4: windows that run out.
CREATE INDEX IF NOT EXISTS "inbound_mails_expiry_idx"
  ON "inbound_mails" ("expires_at") WHERE "status" = 'waiting';
--> statement-breakpoint
-- Sweeps 1 and 2: receptions that never finished, received mail with no job.
CREATE INDEX IF NOT EXISTS "inbound_mails_receiving_idx"
  ON "inbound_mails" ("updated_at") WHERE "status" IN ('receiving', 'received');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mails_settled_idx"
  ON "inbound_mails" ("settled_at") WHERE "status" = 'settled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mails_dropped_idx"
  ON "inbound_mails" ("received_at") WHERE "status" = 'dropped';
--> statement-breakpoint
-- Message-ID reuse and dedupe against the project's mail.
CREATE INDEX IF NOT EXISTS "inbound_mails_message_id_idx"
  ON "inbound_mails" ("project_id", "message_id") WHERE "message_id" IS NOT NULL;
--> statement-breakpoint
-- Sweeps 10 and 13.
CREATE INDEX IF NOT EXISTS "inbound_mails_erasure_deferred_idx"
  ON "inbound_mails" ("erasure_deferred_at") WHERE "erasure_deferred_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mails_original_move_idx"
  ON "inbound_mails" ("original_move_pending_at") WHERE "original_move_pending_at" IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE "inbound_mails" IS
  'One delivery to a project mail address, held until a person files or dismisses its parts (ADR-0134). Holds what a reviewer needs to decide until it settles, then only ids, counts and the member it came from; the message itself is a staged object named by its key. Deleted after the retention window. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_mail_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "mail_id" uuid NOT NULL,
  -- Order in the mail; an attachment is staged at `<mail>/<position>`.
  "position" integer NOT NULL,
  -- message: the mail's own text, read from `read.json`. attachment: one file.
  "kind" text NOT NULL,
  -- An attachment's name, only while its bytes are there; NULL for a file
  -- that came without one (the person names it). The message has neither.
  "filename" text,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  -- sha256 hex of the staged bytes (of the own text for the message),
  -- checked again at filing; `already_filed` compares the message's.
  "sha256" text NOT NULL,
  "storage_key" text,
  "state" text DEFAULT 'waiting' NOT NULL,
  "scan_status" text NOT NULL,
  -- The engine and signature-database version that gave the verdict.
  "scan_engine" text,
  -- The malware signature, for an infected part only.
  "scan_signature" text,
  "scanned_at" timestamp with time zone,
  "scan_attempts" smallint DEFAULT 0 NOT NULL,
  "risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
  "name_stop_terms" text[] DEFAULT '{}'::text[] NOT NULL,
  -- The kinds `findSpans` found in the own text after signature removal (D13).
  "content_findings" text[] DEFAULT '{}'::text[] NOT NULL,
  -- Ids only, no foreign keys: what the viewer may see of them is decided at
  -- read time (RT-S13), and a deleted document simply no longer matches.
  "duplicate_of_document_id" uuid,
  "revision_candidate_document_id" uuid,
  -- The `file` decision this part is being, or was, filed on.
  "decision_id" uuid,
  "claim_expires_at" timestamp with time zone,
  -- Why the last filing attempt made no document; the part waits again.
  "last_failure" text,
  "document_id" uuid,
  "document_version_id" uuid,
  -- The message's entry in its thread, once filed.
  "mail_thread_entry_id" uuid,
  "filed_at" timestamp with time zone,
  -- When it was dismissed or expired: restorable for seven days from here.
  "ended_at" timestamp with time zone,
  "erasure_deferred_at" timestamp with time zone,
  -- Piloti's suggestion, from names and metadata only (D21), and its trace.
  "suggestion" jsonb,
  "suggestion_trace_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbound_mail_parts_mail_fkey"
    FOREIGN KEY ("mail_id", "project_id", "organization_id")
    REFERENCES "inbound_mails"("id", "project_id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "inbound_mail_parts_id_mail_project_org_key"
    UNIQUE ("id", "mail_id", "project_id", "organization_id"),
  CONSTRAINT "inbound_mail_parts_mail_position_key" UNIQUE ("mail_id", "position"),
  -- The filed document in the SAME project; SET NULL on the one column.
  CONSTRAINT "inbound_mail_parts_document_fkey"
    FOREIGN KEY ("document_id", "project_id")
    REFERENCES "documents"("id", "project_id") ON DELETE SET NULL ("document_id"),
  -- The Fassung belongs to THAT document.
  CONSTRAINT "inbound_mail_parts_version_fkey"
    FOREIGN KEY ("document_version_id", "document_id")
    REFERENCES "document_versions"("id", "document_id") ON DELETE SET NULL ("document_version_id"),
  CONSTRAINT "inbound_mail_parts_entry_fkey"
    FOREIGN KEY ("mail_thread_entry_id", "project_id", "organization_id")
    REFERENCES "mail_thread_entries"("id", "project_id", "organization_id") ON DELETE SET NULL ("mail_thread_entry_id"),
  CONSTRAINT "inbound_mail_parts_kind_known" CHECK ("kind" IN ('message', 'attachment')),
  CONSTRAINT "inbound_mail_parts_state_known"
    CHECK ("state" IN ('waiting', 'filing', 'filed', 'dismissed', 'expired')),
  CONSTRAINT "inbound_mail_parts_position_non_negative" CHECK ("position" >= 0),
  CONSTRAINT "inbound_mail_parts_size_bounded" CHECK ("size_bytes" BETWEEN 0 AND 27262976),
  CONSTRAINT "inbound_mail_parts_sha256_shape" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "inbound_mail_parts_content_type_length" CHECK (char_length("content_type") BETWEEN 1 AND 255),
  CONSTRAINT "inbound_mail_parts_filename_length"
    CHECK ("filename" IS NULL OR char_length("filename") BETWEEN 1 AND 500),
  -- The one key an attachment's bytes may have.
  CONSTRAINT "inbound_mail_parts_storage_key_shape"
    CHECK ("storage_key" IS NULL
       OR "storage_key" = 'org/' || "organization_id" || '/project/' || "project_id"::text
                          || '/_inbound-mail/' || "mail_id"::text || '/' || "position"::text),
  CONSTRAINT "inbound_mail_parts_message_has_no_object"
    CHECK ("kind" = 'attachment' OR ("storage_key" IS NULL AND "filename" IS NULL)),
  -- The name goes with the bytes: no name survives their erasure.
  CONSTRAINT "inbound_mail_parts_name_with_bytes"
    CHECK ("storage_key" IS NOT NULL OR "filename" IS NULL),
  -- A person can decide, and the job can file, only while the bytes are there.
  CONSTRAINT "inbound_mail_parts_bytes_while_open"
    CHECK ("kind" = 'message' OR "state" NOT IN ('waiting', 'filing') OR "storage_key" IS NOT NULL),
  -- A filed part's bytes are the document's now, unless a hold stopped the erasure.
  CONSTRAINT "inbound_mail_parts_no_bytes_when_filed"
    CHECK ("state" <> 'filed' OR "storage_key" IS NULL OR "erasure_deferred_at" IS NOT NULL),
  CONSTRAINT "inbound_mail_parts_scan_known"
    CHECK ("scan_status" IN ('pending', 'clean', 'infected', 'failed', 'not_applicable')),
  -- The text is not scanned on its own: its raw message is, whole.
  CONSTRAINT "inbound_mail_parts_scan_applies"
    CHECK (("kind" = 'message') = ("scan_status" = 'not_applicable')),
  CONSTRAINT "inbound_mail_parts_scanned_at"
    CHECK (("scan_status" IN ('pending', 'not_applicable')) = ("scanned_at" IS NULL)),
  CONSTRAINT "inbound_mail_parts_scan_signature_when_infected"
    CHECK ("scan_signature" IS NULL OR "scan_status" = 'infected'),
  CONSTRAINT "inbound_mail_parts_scan_attempts_bounded" CHECK ("scan_attempts" BETWEEN 0 AND 100),
  -- Nothing reaches a project unless its scan said clean (D16).
  CONSTRAINT "inbound_mail_parts_filed_is_clean"
    CHECK ("state" NOT IN ('filing', 'filed') OR "scan_status" IN ('clean', 'not_applicable')),
  CONSTRAINT "inbound_mail_parts_risk_flags_known"
    CHECK ("risk_flags" <@ ARRAY['macro', 'type_mismatch', 'encrypted', 'name_stop', 'duplicate_of',
                                 'forwarded_inner', 'unreadable', 'unverified_thread', 'type_not_accepted']::text[]),
  CONSTRAINT "inbound_mail_parts_name_stop_terms"
    CHECK (cardinality("name_stop_terms") <= 20
       AND (cardinality("name_stop_terms") = 0 OR 'name_stop' = ANY ("risk_flags"))),
  CONSTRAINT "inbound_mail_parts_content_findings"
    CHECK (cardinality("content_findings") <= 32
       AND (cardinality("content_findings") = 0 OR "kind" = 'message')),
  CONSTRAINT "inbound_mail_parts_duplicate_flagged"
    CHECK ("duplicate_of_document_id" IS NULL OR 'duplicate_of' = ANY ("risk_flags")),
  -- The database's half of "no mail is filed without a person" (RT-S7): the
  -- decision is this part's (composite key), and a `file` (trigger).
  CONSTRAINT "inbound_mail_parts_decision_iff_filing"
    CHECK (("state" IN ('filing', 'filed')) = ("decision_id" IS NOT NULL)),
  CONSTRAINT "inbound_mail_parts_claim_while_filing"
    CHECK (("state" = 'filing') = ("claim_expires_at" IS NOT NULL)),
  CONSTRAINT "inbound_mail_parts_failure_known"
    CHECK ("last_failure" IS NULL OR "last_failure" IN
      ('screened', 'type', 'size', 'quota', 'access', 'name_taken', 'unreadable', 'digest_mismatch',
       'unavailable', 'thread_document_gone', 'scan_not_clean', 'project_closed', 'type_not_accepted')),
  CONSTRAINT "inbound_mail_parts_failure_while_waiting"
    CHECK ("last_failure" IS NULL OR "state" = 'waiting'),
  CONSTRAINT "inbound_mail_parts_filed_at" CHECK (("state" = 'filed') = ("filed_at" IS NOT NULL)),
  CONSTRAINT "inbound_mail_parts_ended_at"
    CHECK (("state" IN ('dismissed', 'expired')) = ("ended_at" IS NOT NULL)),
  -- The document is gone when somebody deletes it (SET NULL); the part stays filed.
  CONSTRAINT "inbound_mail_parts_document_only_when_filed"
    CHECK ("document_id" IS NULL OR "state" = 'filed'),
  CONSTRAINT "inbound_mail_parts_version_only_when_filed"
    CHECK ("document_version_id" IS NULL OR "state" = 'filed'),
  CONSTRAINT "inbound_mail_parts_entry_only_for_filed_message"
    CHECK ("mail_thread_entry_id" IS NULL OR ("kind" = 'message' AND "state" = 'filed')),
  -- A suggestion names a file: it goes with the bytes (the text's, until filed).
  CONSTRAINT "inbound_mail_parts_suggestion_with_bytes"
    CHECK ("suggestion" IS NULL OR (jsonb_typeof("suggestion") = 'object'
       AND ("storage_key" IS NOT NULL OR ("kind" = 'message' AND "state" <> 'filed'))))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_parts_document_idx"
  ON "inbound_mail_parts" ("document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
-- Sweep 5: claims that ran out.
CREATE INDEX IF NOT EXISTS "inbound_mail_parts_claim_idx"
  ON "inbound_mail_parts" ("claim_expires_at") WHERE "state" = 'filing';
--> statement-breakpoint
-- Sweep 6: dismissed and expired parts still holding bytes.
CREATE INDEX IF NOT EXISTS "inbound_mail_parts_ended_bytes_idx"
  ON "inbound_mail_parts" ("ended_at") WHERE "storage_key" IS NOT NULL AND "state" IN ('dismissed', 'expired');
--> statement-breakpoint
-- Sweep 7: scans to try again.
CREATE INDEX IF NOT EXISTS "inbound_mail_parts_scan_failed_idx"
  ON "inbound_mail_parts" ("scanned_at") WHERE "scan_status" = 'failed';
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_parts" IS
  'What a person can file from a received mail: its own text or one attachment, and where it stands. An attachment''s bytes are staged only while a person can still decide (and seven days after a dismissal or expiry). A filing or filed part names the file decision of a person; only a clean scan is ever filed. Tenant data (migration 0186).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_mail_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "mail_id" uuid NOT NULL,
  "part_id" uuid NOT NULL,
  "action" text NOT NULL,
  -- Always a person. The filing job runs as them, the audit event names them.
  "decided_by" text NOT NULL,
  "via" text DEFAULT 'app' NOT NULL,
  "proposal_id" uuid,
  "follow_id" uuid,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- file: where the part goes. No foreign keys: the folder or document may go
  -- before the decision reaches the trail, and the row carries what was decided.
  -- `folder_path` is the destination as it was ('' is the project root),
  -- created by the job when it does not exist.
  "folder_id" uuid,
  "folder_path" text,
  -- The name to file under (the new thread's name for a message); NULL keeps the part's own.
  "file_name" text,
  -- revisionOf: file as the next Fassung of this document.
  "target_document_id" uuid,
  "document_type" text,
  -- A message only: into which thread, and in which form.
  "thread_action" text,
  "mail_thread_id" uuid,
  "message_text" text,
  -- What the person explicitly accepted; read by the filing job from here and
  -- nowhere else.
  "screening_release" boolean DEFAULT false NOT NULL,
  "acknowledged_sender" boolean DEFAULT false NOT NULL,
  "acknowledged_risk" boolean DEFAULT false NOT NULL,
  -- When the audit trail took it; NULL while it is owed.
  "audited_at" timestamp with time zone,
  CONSTRAINT "inbound_mail_decisions_part_fkey"
    FOREIGN KEY ("part_id", "mail_id", "project_id", "organization_id")
    REFERENCES "inbound_mail_parts"("id", "mail_id", "project_id", "organization_id") ON DELETE CASCADE,
  -- What a part's composite key points at: a decision about that part.
  CONSTRAINT "inbound_mail_decisions_id_part_key" UNIQUE ("id", "part_id"),
  -- A follow decision is the follower's own (D31): the decider, the thread and
  -- the organization are the follow's. A thread deleted with its follows takes
  -- their decisions along, once they are audited (the guard below).
  CONSTRAINT "inbound_mail_decisions_follower_fkey"
    FOREIGN KEY ("follow_id", "mail_thread_id", "decided_by", "organization_id")
    REFERENCES "mail_thread_follows"("id", "thread_id", "user_id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "inbound_mail_decisions_action_known" CHECK ("action" IN ('file', 'dismiss', 'restore')),
  CONSTRAINT "inbound_mail_decisions_decider_is_person" CHECK ("decided_by" ~ '^user_[0-9A-Z]{26}$'),
  CONSTRAINT "inbound_mail_decisions_via_known"
    CHECK ("via" IN ('app', 'agent', 'piloti_proposal', 'follow')),
  CONSTRAINT "inbound_mail_decisions_proposal_iff_card"
    CHECK (("via" = 'piloti_proposal') = ("proposal_id" IS NOT NULL)),
  CONSTRAINT "inbound_mail_decisions_follow_iff_follow"
    CHECK (("via" = 'follow') = ("follow_id" IS NOT NULL)),
  -- Only a filing has a destination; appending to a thread has its document.
  CONSTRAINT "inbound_mail_decisions_destination_when_filing"
    CHECK (("action" = 'file' AND "thread_action" IS DISTINCT FROM 'append') = ("folder_path" IS NOT NULL)),
  CONSTRAINT "inbound_mail_decisions_target_only_when_filing"
    CHECK ("action" = 'file' OR (
      "folder_id" IS NULL AND "file_name" IS NULL AND "target_document_id" IS NULL
      AND "document_type" IS NULL AND "thread_action" IS NULL
      AND NOT "screening_release" AND NOT "acknowledged_sender" AND NOT "acknowledged_risk")),
  CONSTRAINT "inbound_mail_decisions_thread_action_known"
    CHECK ("thread_action" IS NULL OR "thread_action" IN ('append', 'create')),
  CONSTRAINT "inbound_mail_decisions_thread_named"
    CHECK (("thread_action" IS NOT DISTINCT FROM 'append') = ("mail_thread_id" IS NOT NULL)
       AND ("thread_action" IS DISTINCT FROM 'create' OR "file_name" IS NOT NULL)),
  CONSTRAINT "inbound_mail_decisions_message_text"
    CHECK (("thread_action" IS NULL) = ("message_text" IS NULL)
       AND ("message_text" IS NULL OR "message_text" IN ('masked', 'full'))),
  CONSTRAINT "inbound_mail_decisions_lengths"
    CHECK (("folder_path" IS NULL OR char_length("folder_path") <= 1000)
       AND ("file_name" IS NULL OR char_length("file_name") BETWEEN 1 AND 255)
       -- A tag of the shared Dokumentart vocabulary (`lib/documents/tag-vocabulary.ts`),
       -- which the decision's wire refines to and the filing job reads through
       -- (`documentTypeOf`): membership is the code's, because the vocabulary
       -- still holds persisted German keys („Norm/Richtlinie“) a token shape
       -- would refuse. The database bounds the value and keeps it one printable line.
       AND ("document_type" IS NULL
            OR (char_length("document_type") BETWEEN 1 AND 64 AND "document_type" !~ '[[:cntrl:]]'))),
  -- A Piloti card files clean, unflagged parts only (RT-S5): every
  -- acknowledgement and release is a person's act in the app or as themselves.
  CONSTRAINT "inbound_mail_decisions_piloti_cards_file_clean"
    CHECK ("via" <> 'piloti_proposal'
       OR (NOT "screening_release" AND NOT "acknowledged_risk" AND NOT "acknowledged_sender")),
  -- A follow appends a message's text to its thread and nothing else (D31).
  CONSTRAINT "inbound_mail_decisions_follow_appends_text_only"
    CHECK ("via" <> 'follow'
       OR ("action" = 'file' AND "thread_action" = 'append'
           AND NOT "screening_release" AND NOT "acknowledged_risk" AND NOT "acknowledged_sender"))
);
--> statement-breakpoint
-- A part names its file decision: (decision_id, id) is a decision ABOUT THIS
-- part. The two tables reference each other, so this key is added once both
-- exist (dropped first, so a re-run of this file is a no-op). A decision
-- deleted with its follow takes the part it filed along.
ALTER TABLE "inbound_mail_parts" DROP CONSTRAINT IF EXISTS "inbound_mail_parts_decision_fkey";
--> statement-breakpoint
ALTER TABLE "inbound_mail_parts"
  ADD CONSTRAINT "inbound_mail_parts_decision_fkey"
  FOREIGN KEY ("decision_id", "id")
  REFERENCES "inbound_mail_decisions"("id", "part_id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_decisions_part_idx"
  ON "inbound_mail_decisions" ("part_id", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_decisions_mail_idx"
  ON "inbound_mail_decisions" ("mail_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_decisions_follow_idx"
  ON "inbound_mail_decisions" ("follow_id", "decided_at") WHERE "follow_id" IS NOT NULL;
--> statement-breakpoint
-- Sweep 11: what is still owed to the trail, found without a scan.
CREATE INDEX IF NOT EXISTS "inbound_mail_decisions_due_idx"
  ON "inbound_mail_decisions" ("decided_at") WHERE "audited_at" IS NULL;
--> statement-breakpoint
COMMENT ON TABLE "inbound_mail_decisions" IS
  'Append-only: every file, dismiss or restore a person decided on a received mail''s part, and how it reached us. The filing job reads what to do from here, the audit trail is sent from here (audited_at). Only audited_at changes, once; a row is deleted only after it was audited, unless its project is purged. Tenant data (migration 0186).';
--> statement-breakpoint
-- A part's decision is a `file` (RT-S7). The composite key already makes it a
-- decision about this part; what a key cannot say is which action it was.
CREATE OR REPLACE FUNCTION grid_inbound_mail_parts_decision_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  decided_action text;
BEGIN
  IF NEW.decision_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.decision_id IS NOT DISTINCT FROM OLD.decision_id) THEN
    RETURN NEW;
  END IF;
  SELECT action INTO decided_action FROM inbound_mail_decisions WHERE id = NEW.decision_id;
  -- Not found: the composite key refuses it, with its own name.
  IF FOUND AND decided_action <> 'file' THEN
    RAISE EXCEPTION 'an inbound mail part is filed only on a file decision, not on %', decided_action
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inbound_mail_parts_decision_files',
            TABLE = 'inbound_mail_parts';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_parts_decision_guard" ON "inbound_mail_parts";
--> statement-breakpoint
CREATE TRIGGER "inbound_mail_parts_decision_guard"
  BEFORE INSERT OR UPDATE OF "decision_id" ON "inbound_mail_parts"
  FOR EACH ROW EXECUTE FUNCTION grid_inbound_mail_parts_decision_guard();
--> statement-breakpoint
-- A filed part's Fassung goes with its document. Deleting the document sets
-- `document_id` NULL first (its key), and from then on the composite key to the
-- Fassung is MATCH SIMPLE-unchecked, so that key's own SET NULL never fires and
-- the part would keep a dangling `document_version_id`. The guard clears it,
-- as `grid_mail_thread_entry_attachments_guard` does for D36's rows.
CREATE OR REPLACE FUNCTION grid_inbound_mail_parts_document_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_id IS NULL THEN
    NEW.document_version_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_parts_document_guard" ON "inbound_mail_parts";
--> statement-breakpoint
CREATE TRIGGER "inbound_mail_parts_document_guard"
  BEFORE UPDATE OF "document_id" ON "inbound_mail_parts"
  FOR EACH ROW EXECUTE FUNCTION grid_inbound_mail_parts_document_guard();
--> statement-breakpoint
-- The decisions' three rules no CHECK can state, one per operation:
--
--   INSERT  a thread is chosen for the mail's text and nothing else, and a
--           filed text always goes into one; a follow files a text (D31).
--   UPDATE  nothing changes but `audited_at`, once, from NULL to a time.
--   DELETE  only after the audit trail took it (RT-S8), unless the project is
--           gone: a purge deletes the project row first and cascades from it,
--           so inside the cascade the project no longer exists.
CREATE OR REPLACE FUNCTION grid_inbound_mail_decisions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  part_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT kind INTO part_kind FROM inbound_mail_parts WHERE id = NEW.part_id;
    IF NOT FOUND THEN
      RETURN NEW;  -- the composite key refuses it, with its own name
    END IF;
    IF NEW.via = 'follow' AND part_kind <> 'message' THEN
      RAISE EXCEPTION 'a follow appends a mail''s text, never an attachment'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inbound_mail_decisions_follow_files_text',
              TABLE = 'inbound_mail_decisions';
    END IF;
    IF (NEW.thread_action IS NOT NULL) <> (part_kind = 'message' AND NEW.action = 'file') THEN
      RAISE EXCEPTION 'a thread is chosen for a filed mail text, and only for it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inbound_mail_decisions_thread_for_text',
              TABLE = 'inbound_mail_decisions';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.audited_at IS NOT NULL
       OR NEW.audited_at IS NULL
       OR (to_jsonb(NEW) - 'audited_at') IS DISTINCT FROM (to_jsonb(OLD) - 'audited_at') THEN
      RAISE EXCEPTION 'an inbound mail decision is never changed, only marked audited once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inbound_mail_decisions_immutable',
              TABLE = 'inbound_mail_decisions';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.audited_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RAISE EXCEPTION 'an inbound mail decision is deleted only after the audit trail took it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inbound_mail_decisions_audited_before_delete',
            TABLE = 'inbound_mail_decisions';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_decisions_guard" ON "inbound_mail_decisions";
--> statement-breakpoint
CREATE TRIGGER "inbound_mail_decisions_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "inbound_mail_decisions"
  FOR EACH ROW EXECUTE FUNCTION grid_inbound_mail_decisions_guard();
--> statement-breakpoint
-- The legal-hold backstop for rows whose hold is their PROJECT's (0093 keys
-- its guard on the row's own id): a held mail or filed message is not deleted,
-- by a sweep, a cascade or a script. The sweeps filter holds in their WHERE
-- (RT-S20), so this is what still holds when one forgets.
CREATE OR REPLACE FUNCTION grid_refuse_held_project_row_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF grid_legal_hold_blocks('project', OLD.project_id::text, OLD.organization_id) THEN
    RAISE EXCEPTION 'legal hold: % % of project % is covered by an active legal hold and cannot be deleted',
      TG_TABLE_NAME, OLD.id, OLD.project_id
      USING ERRCODE = 'GLH01';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mails_legal_hold_guard" ON "inbound_mails";
--> statement-breakpoint
CREATE TRIGGER "inbound_mails_legal_hold_guard"
  BEFORE DELETE ON "inbound_mails"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_held_project_row_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entries_legal_hold_guard" ON "mail_thread_entries";
--> statement-breakpoint
CREATE TRIGGER "mail_thread_entries_legal_hold_guard"
  BEFORE DELETE ON "mail_thread_entries"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_held_project_row_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entry_attachments_legal_hold_guard" ON "mail_thread_entry_attachments";
--> statement-breakpoint
CREATE TRIGGER "mail_thread_entry_attachments_legal_hold_guard"
  BEFORE DELETE ON "mail_thread_entry_attachments"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_held_project_row_delete();
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_addresses', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('inbound_mails', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_parts', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('inbound_mail_decisions', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('mail_threads', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('mail_thread_entries', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('mail_thread_entry_attachments', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('mail_thread_message_ids', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('mail_thread_follows', 'organization_id = grid_current_org()');
--> statement-breakpoint
-- After `grid_secure_table`, which grants DELETE, so a re-run revokes again.
-- See "Ending is a state" in the header.
REVOKE DELETE ON "inbound_mail_addresses", "inbound_mails", "inbound_mail_parts", "inbound_mail_decisions",
  "mail_threads", "mail_thread_entries", "mail_thread_entry_attachments", "mail_thread_follows" FROM grid_app_rw;
