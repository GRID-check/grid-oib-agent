// Package webdav is the WebDAV protocol adapter — a SECOND front for the same
// authorization core the NFS adapter uses. It resolves an authenticated Subject
// per HTTP request (via an HTTPResolver), stashes it in the request context, and
// hands golang.org/x/net/webdav a FileSystem whose every operation is authorized
// through the StoragePort. This package is the only place that knows about
// WebDAV; the Guard, Engine, policy client, and StoragePort are untouched
// (ADR-2). It proves the ports-and-adapters authz core plugs behind
// identity-carrying HTTP just as it does behind NFS mounts.
package webdav

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	xwebdav "golang.org/x/net/webdav"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/storage"
)

// ctxKey is a private context key type so no other package can collide with (or
// forge) the stashed Subject.
type ctxKey struct{}

var subjectKey = ctxKey{}

// withSubject returns a child context carrying subj.
func withSubject(ctx context.Context, subj authz.Subject) context.Context {
	return context.WithValue(ctx, subjectKey, subj)
}

// subjectFrom extracts the Subject stashed by the Handler. The boolean is false
// if none is present — which, given the Handler always sets it before delegating,
// can only happen if a FileSystem method is called outside the request pipeline
// (a programming error), and the FileSystem then fails closed with ErrPermission.
func subjectFrom(ctx context.Context) (authz.Subject, bool) {
	subj, ok := ctx.Value(subjectKey).(authz.Subject)
	return subj, ok
}

// authHandler resolves identity, stashes the Subject, and delegates to the
// wrapped webdav.Handler.
type authHandler struct {
	resolver HTTPResolver
	dav      *xwebdav.Handler
	log      *slog.Logger
}

// NewHandler builds the WebDAV http.Handler. Every request is authenticated by
// resolver (401 on failure), and every file operation the delegated
// webdav.Handler performs is authorized per-file against port for the resolved
// Subject — the exact same Guard the NFS front calls.
func NewHandler(port storage.StoragePort, resolver HTTPResolver, log *slog.Logger) http.Handler {
	return &authHandler{
		resolver: resolver,
		dav: &xwebdav.Handler{
			FileSystem: &boundFS{port: port},
			// An in-memory lock system satisfies WebDAV clients (macOS Finder,
			// Windows mini-redirector) that LOCK before PUT. It is per-process and
			// advisory only: it does NOT gate authorization (the StoragePort does)
			// and does not coordinate across gateway replicas — a shared lock store
			// is a follow-up. See the locking caveat in the package docs.
			LockSystem: xwebdav.NewMemLS(),
			Logger: func(r *http.Request, err error) {
				if err != nil {
					log.Warn("webdav op", "method", r.Method, "path", r.URL.Path, "err", err)
				}
			},
		},
		log: log,
	}
}

func (h *authHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	subj, err := h.resolver.Resolve(r)
	if err != nil {
		// Two distinct failure modes, and conflating them breaks the mount UX:
		//   - ErrUnauthenticated → 401 + the resolver's challenge, which is what
		//     makes the native OS credential dialog appear (Basic) or an API
		//     client present a token (Bearer).
		//   - anything else (the credential VERIFIER is unreachable, e.g. BFF
		//     down) → 503. Returning 401 here would make every mounted client
		//     re-prompt its user for a password that is not wrong — during an
		//     outage, of all times. Clients retry a 503 silently.
		if errors.Is(err, ErrUnauthenticated) {
			h.log.Warn("webdav request denied: unauthenticated",
				"method", r.Method, "path", r.URL.Path, "resolver", h.resolver.Name())
			w.Header().Set("WWW-Authenticate", h.resolver.Challenge())
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.log.Error("webdav authentication unavailable",
			"method", r.Method, "path", r.URL.Path, "resolver", h.resolver.Name(), "err", err)
		http.Error(w, "authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	// Stash the authenticated Subject so the FileSystem — which only sees a
	// context — authorizes as this caller. The webdav.Handler threads r.Context()
	// into every FileSystem call.
	r = r.WithContext(withSubject(r.Context(), subj))
	h.dav.ServeHTTP(w, r)
}
