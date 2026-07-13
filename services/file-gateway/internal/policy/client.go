// Package policy is the boundary to the external authorization service (WorkOS
// FGA). It speaks in plain identifiers (subject/relation/object strings) so it
// stays a leaf with no dependency on the authorization core -- the core depends
// on this interface, not the other way around.
package policy

import "context"

// Client evaluates warrant checks against the policy service.
//
// Check answers: does <subject> have <relation> on <object>? BatchCheck answers
// the same for many objects in one round-trip (used for directory listings).
type Client interface {
	Check(ctx context.Context, subject, relation, object string) (bool, error)
	BatchCheck(ctx context.Context, subject, relation string, objects []string) (map[string]bool, error)
}
