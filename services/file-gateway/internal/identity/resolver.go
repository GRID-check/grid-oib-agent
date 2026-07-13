// Package identity maps a protocol-level identity to an authenticated WorkOS
// Subject. This is the ONLY component that differs across protocol fronts
// (ADR-2): NFSv3 dev share-per-subject, NFSv4+Kerberos, or SMB session user. The
// authorization core, cache, policy client, and storage port are identical
// regardless. Never construct an authz.Subject outside a Resolver.
package identity

import (
	"context"

	"gridnas/gateway/internal/authz"
)

// ProtocolIdentity carries whatever the protocol layer learned about the caller.
// Different fronts populate different fields.
type ProtocolIdentity struct {
	Dirpath   string // NFS export path (dev share-per-subject)
	ClientIP  string // transport source address
	Principal string // Kerberos principal (NFSv4/RPCSEC_GSS)
	SMBUser   string // authenticated SMB session user
}

// Resolver turns a ProtocolIdentity into an authenticated Subject, or an error if
// the caller cannot be authenticated.
type Resolver interface {
	Resolve(ctx context.Context, pid ProtocolIdentity) (authz.Subject, error)
	// Name identifies the resolver for config validation and audit.
	Name() string
}
