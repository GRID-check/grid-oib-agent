/**
 * How long a custom role's name and description may be (ADR-0080). Shared by
 * the routes that validate them and the editor that counts them, so a name the
 * field accepts is one the route accepts.
 */

export const ROLE_NAME_MAX = 64
export const ROLE_DESCRIPTION_MAX = 150
