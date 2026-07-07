CREATE TABLE IF NOT EXISTS "org_model_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_snapshot" jsonb,
	"comment" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_model_configs" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"active_version_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_model_configs" ADD CONSTRAINT "org_model_configs_active_version_id_org_model_config_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."org_model_config_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_model_config_versions_org_version" ON "org_model_config_versions" USING btree ("organization_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_model_config_versions_org" ON "org_model_config_versions" USING btree ("organization_id","created_at");
