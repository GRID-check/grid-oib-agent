-- Reverse 0031: back to resolving tenancy through the parent conversation.
SELECT grid_secure_table('messages',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');
SELECT grid_secure_table('conversation_reads',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_id_organization_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_id_conversations_id_fk
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE;
ALTER TABLE messages DROP COLUMN IF EXISTS organization_id;

ALTER TABLE conversation_reads DROP CONSTRAINT IF EXISTS conversation_reads_conversation_id_organization_id_fkey;
ALTER TABLE conversation_reads
  ADD CONSTRAINT conversation_reads_conversation_id_conversations_id_fk
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE;
ALTER TABLE conversation_reads DROP COLUMN IF EXISTS organization_id;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_id_organization_id_key;
