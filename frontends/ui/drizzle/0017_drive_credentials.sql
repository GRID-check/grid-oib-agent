-- Drive (mount) device credentials — ADR-0025.
-- SSO-brokered: created only inside a WorkOS-SSO'd web session, then used as
-- Basic auth by native macOS/Windows WebDAV mount dialogs. Only a SHA-256 hash
-- of the secret is stored (the secret is high-entropy and shown once);
-- authorization stays per-file-op via WorkOS FGA, so a credential grants
-- nothing once the user's role/membership is gone.
CREATE TABLE IF NOT EXISTS "drive_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"username" text NOT NULL,
	"label" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drive_credentials_user" ON "drive_credentials" ("user_id","organization_id","created_at");
