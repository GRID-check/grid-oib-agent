CREATE TABLE IF NOT EXISTS "organizations" (
	"workos_organization_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
