// Package authz is the authorization core. It is pure: given a FileOp it returns
// allow/deny using a policy.Client and a decision cache, and emits an audit
// record. It imports no protocol (NFS/SMB), no storage (billy/S3), and no
// net/http -- which is what makes it unit-testable and the single source of
// truth for relation semantics and the OIB layering.
package authz

import "path"

// Subject is an authenticated WorkOS principal. It is produced only by an
// identity.Resolver; never construct one from client-asserted data elsewhere.
type Subject struct {
	ID    string // WorkOS user id (user_...)
	OrgID string // WorkOS organization id (org_...) the mount is scoped to
	Env   string // deployment env, carried for audit / multi-tenant scoping
}

// Relation is the typed access level. Using a typed enum (not bare "viewer" /
// "editor" strings scattered at call sites) means the op->relation mapping lives
// in exactly one place and cannot drift.
type Relation int

const (
	Viewer Relation = iota // read / stat / list
	Editor                 // create / write / remove / rename / mkdir / setattr
)

func (r Relation) String() string {
	switch r {
	case Editor:
		return "editor"
	default:
		return "viewer"
	}
}

// FileOp is a single authorization question.
type FileOp struct {
	Subject  Subject
	Relation Relation
	Object   string // logical object id, e.g. "document:org-acme/project-atlas/plan.pdf"
}

// ObjectFor derives the WorkOS FGA object id from a storage path. The knowledge
// layering (OIB core -> org -> project -> session) is encoded in the path; WorkOS
// resolves inheritance via the warrant graph. Cleaning defends against traversal
// ("../") in derived object ids.
func ObjectFor(p string) string {
	clean := path.Clean("/" + p)
	if clean == "/" {
		return "" // the mount root: a traversal point, not a protected object
	}
	return "document:" + clean[1:]
}

// IsRoot reports whether a path refers to the export root (never gated).
func IsRoot(p string) bool { return ObjectFor(p) == "" }
