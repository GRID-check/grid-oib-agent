package webdav

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func basicReq(user, pass string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/x.pdf", nil)
	r.SetBasicAuth(user, pass)
	return r
}

// The happy path: the OS dialog's username/password reaches the BFF with the
// internal token, and an allow becomes a fully-populated Subject.
func TestBasicResolverVerifiesAgainstBFF(t *testing.T) {
	var gotToken, gotUser, gotSecret string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("x-grid-internal-token")
		var req mountAuthReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotUser, gotSecret = req.Username, req.Secret
		_ = json.NewEncoder(w).Encode(mountAuthResp{Allow: true, UserID: "user_1", OrganizationID: "org_acme"})
	}))
	defer srv.Close()

	b := NewBasicResolver(srv.URL, "secret-token", "prod", 2*time.Second)
	subj, err := b.Resolve(basicReq("alice@acme.test", "gdk_abc.def"))
	if err != nil {
		t.Fatalf("expected allow, got %v", err)
	}
	if subj.ID != "user_1" || subj.OrgID != "org_acme" || subj.Env != "prod" {
		t.Fatalf("bad subject: %+v", subj)
	}
	if gotToken != "secret-token" {
		t.Fatalf("must send x-grid-internal-token, got %q", gotToken)
	}
	if gotUser != "alice@acme.test" || gotSecret != "gdk_abc.def" {
		t.Fatalf("bad payload: user=%q secret=%q", gotUser, gotSecret)
	}
}

func TestBasicResolverDeniesAndCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req mountAuthReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		_ = json.NewEncoder(w).Encode(mountAuthResp{
			Allow: req.Secret == "gdk_good", UserID: "user_1", OrganizationID: "org_acme",
		})
	}))
	defer srv.Close()

	b := NewBasicResolver(srv.URL, "t", "prod", 2*time.Second)

	// A wrong password is ErrUnauthenticated (→ 401 + Basic challenge upstream).
	if _, err := b.Resolve(basicReq("alice", "gdk_bad")); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("deny must be ErrUnauthenticated, got %v", err)
	}
	// The negative verdict is cached briefly: an immediate retry (WebDAV clients
	// hammer) does not hit the BFF again.
	if _, err := b.Resolve(basicReq("alice", "gdk_bad")); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("cached deny must still be ErrUnauthenticated")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("negative verdict not cached: %d BFF calls", n)
	}

	// A positive verdict is cached too: the PROPFIND burst costs one BFF call.
	for i := 0; i < 5; i++ {
		if _, err := b.Resolve(basicReq("alice", "gdk_good")); err != nil {
			t.Fatalf("allow %d failed: %v", i, err)
		}
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("positive verdict not cached: %d BFF calls", n)
	}

	// Cache entries expire: advance the clock past the positive TTL.
	base := time.Now()
	b.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, err := b.Resolve(basicReq("alice", "gdk_good")); err != nil {
		t.Fatalf("post-expiry allow failed: %v", err)
	}
	if n := calls.Load(); n != 3 {
		t.Fatalf("expired entry must re-verify: %d BFF calls", n)
	}
}

// Verifier-down is a distinct failure mode from wrong-password: it must NOT be
// ErrUnauthenticated (the handler answers 503, so mounted clients retry
// silently instead of re-prompting every user for a password that isn't wrong).
func TestBasicResolverFailsClosedWithoutReprompt(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden) // wrong internal token, or BFF misconfig
	}))
	defer bad.Close()

	b := NewBasicResolver(bad.URL, "t", "prod", time.Second)
	_, err := b.Resolve(basicReq("alice", "gdk_x"))
	if err == nil || errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("verifier failure must be a non-Unauthenticated error, got %v", err)
	}

	// And errors are never cached: a recovered BFF answers the very next try.
	if _, err := b.Resolve(basicReq("alice", "gdk_x")); err == nil || errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("second call should re-verify and fail the same way, got %v", err)
	}
}

func TestBasicResolverRequiresCredentials(t *testing.T) {
	b := NewBasicResolver("http://unused.invalid", "t", "dev", time.Second)
	r := httptest.NewRequest(http.MethodGet, "/x.pdf", nil) // no Authorization header
	if _, err := b.Resolve(r); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("missing Basic auth must be ErrUnauthenticated, got %v", err)
	}
	if !strings.HasPrefix(b.Challenge(), "Basic ") {
		t.Fatalf("challenge must be Basic so the OS dialog appears, got %q", b.Challenge())
	}
}

// End-to-end through the handler: no credentials → 401 + Basic challenge (this
// is what makes Finder / Windows pop their dialog); verifier down → 503 with NO
// challenge (mounted clients must not re-prompt during an outage).
func TestBasicHandler401ChallengeAnd503(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	h := NewHandler(&fakePort{}, NewBasicResolver(down.URL, "t", "prod", time.Second), discardLog())

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/x.pdf", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no credentials: want 401, got %d", rr.Code)
	}
	if got := rr.Header().Get("WWW-Authenticate"); !strings.HasPrefix(got, "Basic ") {
		t.Fatalf("401 must carry a Basic challenge, got %q", got)
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, basicReq("alice", "gdk_x"))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("verifier down: want 503, got %d", rr.Code)
	}
	if rr.Header().Get("WWW-Authenticate") != "" {
		t.Fatal("503 must NOT carry a challenge (no re-prompt during an outage)")
	}
}
