// Package policy is the boundary to the external authorization service (the BFF's
// FGA, or WorkOS directly). It defines its own small Subject type so it stays a
// leaf (no dependency on the authz core, which depends on this interface).
package policy

import "context"

// Subject is the authenticated principal a decision is made for. OrgID is carried
// so the policy layer can enforce mount-level tenancy (the org the mount was
// scoped to must own the addressed object) — dropping it silently, as an earlier
// version did, made that hard-deny dead code.
type Subject struct {
	ID    string // WorkOS user id (user_...)
	OrgID string // WorkOS org id (org_...) the mount is scoped to; "" = derive from object
}

// Client evaluates authorization checks against the policy service.
//
// Check answers: may <subject> perform <relation> on <object>? BatchCheck answers
// the same for many objects (used for directory listings).
type Client interface {
	Check(ctx context.Context, subject Subject, relation, object string) (bool, error)
	BatchCheck(ctx context.Context, subject Subject, relation string, objects []string) (map[string]bool, error)
}
