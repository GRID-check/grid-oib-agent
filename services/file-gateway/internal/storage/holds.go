package storage

import (
	"context"
	"fmt"
	"os"

	"gridnas/gateway/internal/authz"
)

// HoldChecker answers the compliance question the FGA relation check cannot:
// may these bytes be destroyed, or are they under a legal hold? It is consulted
// by Guard.Remove BEFORE any delete (ADR-0024 §3). The BFF owns `legal_holds`,
// so the production implementation delegates there — the same brain the purger
// re-checks before every destructive step.
//
// Unlike a read authorization, the safe direction here is to BLOCK: a checker
// error means "cannot confirm this is safe to delete," which Guard.Remove treats
// as a refusal (fail closed = bytes preserved).
type HoldChecker interface {
	// DeletionAllowed reports whether destroying the object at path is permitted
	// by compliance (i.e. NOT under an active legal hold). An error means the
	// answer is unknown and the delete must be refused.
	DeletionAllowed(ctx context.Context, subj authz.Subject, path string) (bool, error)
}

// ErrLegalHold is returned by Guard.Remove when a legal hold blocks a delete. It
// wraps os.ErrPermission so protocol adapters (NFS, WebDAV) map it to the natural
// permission-denied status for the client, while the message survives in the
// audit log to explain WHY the delete was refused.
var ErrLegalHold = fmt.Errorf("deletion blocked by active legal hold: %w", os.ErrPermission)

// AllowAllHolds is the no-op checker for deployments with no legal-hold source
// (dev, and the direct-to-WorkOS policy mode where there is no BFF to own holds).
// It permits every delete. Production bff-mode wiring MUST use the BFF-backed
// checker instead — main.go selects it by policy mode.
type AllowAllHolds struct{}

func (AllowAllHolds) DeletionAllowed(context.Context, authz.Subject, string) (bool, error) {
	return true, nil
}

var _ HoldChecker = AllowAllHolds{}
