-- Per-organization BYOK LLM credentials — metadata only (ADR-0022).
-- Key material lives in WorkOS Vault (vault_object_id) or as a local
-- AES-256-GCM envelope (encrypted_key); never in plaintext here.
CREATE TABLE IF NOT EXISTS "org_llm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"secret_backend" text NOT NULL,
	"vault_object_id" text,
	"encrypted_key" text,
	"key_fingerprint" text NOT NULL,
	"key_hint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rotated_from" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_llm_credentials_active" ON "org_llm_credentials" ("organization_id") WHERE "org_llm_credentials"."status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_llm_credentials_org" ON "org_llm_credentials" ("organization_id","created_at");
