CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"collection_name" text NOT NULL,
	"workos_resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_workos_resource_id_unique" UNIQUE("workos_resource_id")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"workos_user_id" text PRIMARY KEY NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL
);
