package webdav

import (
	"errors"
	"net/http"

	"gridnas/gateway/internal/authz"
)

// ErrUnauthenticated is returned when no subject can be derived from a request.
// The Handler maps it to HTTP 401.
var ErrUnauthenticated = errors.New("webdav: unauthenticated")

// HTTPResolver is the WebDAV analogue of identity.Resolver: it turns an
// identity-carrying HTTP request into an authenticated Subject, or an error if
// the caller cannot be authenticated. This is the ONLY component that differs
// between WebDAV and the NFS front — the authorization core, cache, policy
// client, and StoragePort behind it are identical (ADR-2). Never construct an
// authz.Subject outside a resolver.
type HTTPResolver interface {
	Resolve(r *http.Request) (authz.Subject, error)
	// Name identifies the resolver for config validation and audit.
	Name() string
	// Challenge is the WWW-Authenticate value sent with a 401. It decides what
	// the CLIENT does next: `Basic realm=…` makes the native macOS/Windows mount
	// dialog pop its username/password prompt (the whole point of the device-
	// credential flow, ADR-0025); `Bearer …` tells API clients to present a token.
	Challenge() string
}

// Header names carried by the dev header resolver.
const (
	HeaderUserID = "X-Grid-User-Id"
	HeaderOrgID  = "X-Grid-Org-Id"
)

// HeaderResolver derives the subject from X-Grid-User-Id / X-Grid-Org-Id request
// headers.
//
// These headers are client-asserted and trivially spoofable, exactly like the
// NFS dirpath resolver's AUTH_SYS identity, so this resolver is DEV-ONLY. It
// exists so the WebDAV front runs end-to-end without a token issuer, and to keep
// the HTTPResolver seam exercised by the same code paths a production resolver
// will use. Config validation refuses to enable WebDAV with this resolver when
// GATEWAY_ENV != "dev" (see config.Validate); NewHeaderResolver additionally
// fails closed as defence in depth.
//
// PRODUCTION: replace this with a resolver that validates a Bearer credential and
// derives {ID, OrgID, Env} from verified claims — either a WorkOS access token
// verified against the WorkOS JWKS, or a short-lived BFF-issued signed mount
// token. That verification is deliberately NOT implemented here; this type is the
// seam it will slot into. See the TODO in prodResolverSeam below.
type HeaderResolver struct {
	env string
}

// NewHeaderResolver builds the dev header resolver. It returns an error when env
// is not "dev", so a misconfiguration fails at wiring time rather than serving a
// spoofable identity in production.
func NewHeaderResolver(env string) (*HeaderResolver, error) {
	if env != "dev" {
		return nil, errors.New("webdav: header resolver is dev-only and refuses to run when GATEWAY_ENV != dev")
	}
	return &HeaderResolver{env: env}, nil
}

func (r *HeaderResolver) Name() string { return "header" }

func (r *HeaderResolver) Challenge() string { return `Bearer realm="grid-file-gateway"` }

func (r *HeaderResolver) Resolve(req *http.Request) (authz.Subject, error) {
	uid := req.Header.Get(HeaderUserID)
	if uid == "" {
		return authz.Subject{}, ErrUnauthenticated
	}
	// OrgID is optional: mirrors the dirpath resolver, where a bare user id leaves
	// org to be resolved from the object key.
	return authz.Subject{ID: uid, OrgID: req.Header.Get(HeaderOrgID), Env: r.env}, nil
}

// prodResolverSeam documents the production HTTPResolver that will replace
// HeaderResolver. It is intentionally unimplemented — the Handler depends only on
// the HTTPResolver interface, so swapping this in is a wiring change, not a core
// change.
//
// TODO(prod-identity): implement a BearerResolver that (1) extracts the
// Authorization: Bearer <token> header, (2) verifies the token — WorkOS access
// token against the tenant JWKS, or a BFF-issued signed mount token — and (3)
// maps verified claims (sub -> ID, org_id -> OrgID) to authz.Subject. It MUST
// reject unsigned/expired/wrong-audience tokens with ErrUnauthenticated.
type prodResolverSeam interface{ HTTPResolver }

var _ HTTPResolver = (*HeaderResolver)(nil)
