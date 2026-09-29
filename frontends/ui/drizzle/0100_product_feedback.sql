-- 0100: product_feedback — bug reports, ideas, praise and questions about Piloti.
--
-- ## Why
--
-- The only feedback the product could take was a thumb on one answer
-- (`answer_feedback`, WS-7). Everything else a member wanted to tell us — the
-- upload that hangs, the button they cannot find, the workflow they wish
-- existed — had no door, so it went nowhere or into somebody's private mail.
-- This table is that door: one report per submission, written from wherever
-- the member was, triaged by the platform owners on Platform → Feedback and
-- announced to them in their inbox.
--
-- ## Why not a row in answer_feedback
--
-- A down-vote feeds the platform-lessons pipeline, which distils it into text
-- injected into every agent turn. A product report must never travel that
-- road: "the viewer is slow in Firefox" is not a lesson for the answering
-- agent. Separate tables keep the pipelines separate by construction.
--
-- ## The bounds live here
--
-- The form and the zod schema count against the same numbers, but a CHECK is
-- the layer that holds for a writer that never read the TypeScript.
--
-- ## RLS
--
-- Tenant data keyed directly by the organization it was written from, secured
-- exactly as `organization_instructions` (0087). The platform triage page reads
-- across tenants under the audited platform bypass. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "product_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "user_name" text,
  "user_email" text,
  "kind" text NOT NULL,
  "message" text NOT NULL,
  "page_path" text,
  "context" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "allow_contact" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "triaged_by" text,
  "triaged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_feedback_kind"
    CHECK ("kind" IN ('bug', 'idea', 'praise', 'question')),
  CONSTRAINT "product_feedback_status"
    CHECK ("status" IN ('new', 'in_progress', 'resolved', 'dismissed')),
  -- Characters, not bytes: the counter under the textarea counts characters,
  -- and an umlaut must not cost two of them.
  CONSTRAINT "product_feedback_message_length"
    CHECK (char_length("message") <= 5000),
  -- A report that says nothing is not a report. The form refuses it; this is
  -- the layer that holds when something else tries.
  CONSTRAINT "product_feedback_message_not_blank"
    CHECK (btrim("message") <> ''),
  CONSTRAINT "product_feedback_page_length"
    CHECK ("page_path" IS NULL OR char_length("page_path") <= 500),
  -- Triage is attributed: a report that left `new` says who moved it.
  CONSTRAINT "product_feedback_triage_attributed"
    CHECK ("status" = 'new' OR ("triaged_by" IS NOT NULL AND "triaged_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_feedback_status_created_idx"
  ON "product_feedback" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_feedback_org_user_created_idx"
  ON "product_feedback" USING btree ("organization_id", "user_id", "created_at");
--> statement-breakpoint
COMMENT ON TABLE "product_feedback" IS
  'Product feedback (bug, idea, praise, question) a member sent to the platform owners from inside the app. Tenant data; triaged on Platform -> Feedback under the platform bypass. Never an input to platform lessons.';
--> statement-breakpoint
SELECT grid_secure_table('product_feedback', 'organization_id = grid_current_org()');
