import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drive (mount) device credentials — ADR-0025.
 *
 * A credential is minted ONLY inside a WorkOS-SSO'd web session ("Connect a
 * device"), then typed once into the native macOS/Windows mount dialog, which
 * stores it in the OS keychain and presents it as WebDAV Basic auth. Only the
 * SHA-256 hash of the (high-entropy, shown-once) secret is stored here.
 *
 * The credential AUTHENTICATES the mount; it authorizes nothing by itself —
 * every file operation is still checked live against WorkOS FGA, so removing a
 * user's role/membership makes an already-mounted drive go dark regardless of
 * this row's state. `expiresAt` bounds how long a device can go without the
 * user re-passing SSO in the web app; `revokedAt` is the immediate kill switch.
 */
export const driveCredentials = pgTable(
  'drive_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    organizationId: text('organization_id').notNull(),
    /** Username the OS dialog expects — the user's email at issuance. */
    username: text('username').notNull(),
    /** User-chosen device label ("Work MacBook"). */
    label: text('label').notNull(),
    /** SHA-256 hex of the full secret string; the plaintext is never stored. */
    secretHash: text('secret_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('idx_drive_credentials_user').on(table.userId, table.organizationId, table.createdAt),
  }),
)

export type DriveCredential = typeof driveCredentials.$inferSelect
export type NewDriveCredential = typeof driveCredentials.$inferInsert
