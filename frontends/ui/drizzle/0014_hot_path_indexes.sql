CREATE INDEX IF NOT EXISTS "projects_org_deleted_created_idx" ON "projects" ("organization_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_updated_idx" ON "conversations" ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_project_idx" ON "conversations" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "messages" ("conversation_id","created_at");
