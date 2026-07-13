package identity

import (
	"context"
	"errors"
	"strings"

	"gridnas/gateway/internal/authz"
)

// ErrUnauthenticated is returned when no subject can be derived.
var ErrUnauthenticated = errors.New("identity: unauthenticated")

// DirpathResolver derives the subject from the NFS export path (share-per-subject):
//
//	mount -t nfs gw:/<orgId>/<userId> /mnt   ->  subject {OrgID:<orgId>, ID:<userId>}
//	mount -t nfs gw:/<userId> /mnt           ->  subject {ID:<userId>}          (org from object key)
//
// AUTH_SYS/AUTH_NULL identity is client-asserted and spoofable, so this resolver
// is DEV-ONLY. Config validation refuses to start with it when env != "dev"
// (see config.Validate). It exists so the stack runs end-to-end without a KDC or
// an SMB domain, and to keep the Resolver seam exercised by the same code paths a
// production resolver (signed mount token → user+org) will use.
type DirpathResolver struct {
	env string
}

func NewDirpathResolver(env string) *DirpathResolver { return &DirpathResolver{env: env} }

func (r *DirpathResolver) Name() string { return "dirpath" }

func (r *DirpathResolver) Resolve(_ context.Context, pid ProtocolIdentity) (authz.Subject, error) {
	seg := strings.Split(strings.Trim(pid.Dirpath, "/"), "/")
	switch {
	case len(seg) >= 2 && seg[0] != "" && seg[1] != "":
		return authz.Subject{OrgID: seg[0], ID: seg[1], Env: r.env}, nil
	case len(seg) >= 1 && seg[0] != "":
		return authz.Subject{ID: seg[0], Env: r.env}, nil
	default:
		return authz.Subject{}, ErrUnauthenticated
	}
}
