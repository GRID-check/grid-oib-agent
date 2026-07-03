ALTER TABLE "projects" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_prompt_view" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_display" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_highlights" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "profile_updated_at" timestamp with time zone;
