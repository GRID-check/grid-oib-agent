CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"filename" text NOT NULL,
	"minio_key" text NOT NULL,
	"collection_name" text NOT NULL,
	"file_size" integer,
	"content_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "documents_collection_idx" ON "documents" USING btree ("collection_name");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");
