package webdav

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"gridnas/gateway/internal/authz"
)

// BasicResolver is the PRODUCTION WebDAV identity resolver (ADR-0025): it turns
// the username/password a native macOS/Windows mount dialog presents (WebDAV
// Basic auth) into an authenticated Subject by verifying it against the BFF's
// internal mount-auth endpoint — where the credential was minted inside a
// WorkOS-SSO'd web session. The SSO moment therefore lives at credential
// issuance (and every TTL-forced re-issue); this resolver only authenticates.
// Authorization stays per-file-op via the Guard/FGA path, so a stolen or stale
// credential grants nothing once the user's role or membership is gone.
//
// TRANSPORT: Basic auth is plaintext-equivalent; this front MUST only ever be
// reachable through TLS (terminated at the ingress). Windows' WebClient refuses
// Basic over http:// by default, which is the correct client-side backstop.
//
// A small in-process cache absorbs the WebDAV chatter (clients fire bursts of
// PROPFINDs): positive verdicts are held briefly so steady-state traffic does
// not hammer the BFF; negatives are held even shorter, just enough to blunt a
// brute-force loop without making a freshly-minted credential feel broken.
type BasicResolver struct {
	endpoint string // BFF mount-auth URL, e.g. http://frontend:3000/api/internal/mount-auth
	token    string // GRID_INTERNAL_API_TOKEN
	env      string
	http     *http.Client

	posTTL time.Duration
	negTTL time.Duration
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]basicCacheEntry
}

type basicCacheEntry struct {
	subject authz.Subject
	allow   bool
	expires time.Time
}

// basicCacheMax bounds the credential-verdict cache. One entry per distinct
// (user,secret) pair actively mounting — thousands, not millions.
const basicCacheMax = 4096

func NewBasicResolver(endpoint, token, env string, timeout time.Duration) *BasicResolver {
	return &BasicResolver{
		endpoint: endpoint,
		token:    token,
		env:      env,
		http:     &http.Client{Timeout: timeout},
		posTTL:   60 * time.Second,
		negTTL:   5 * time.Second,
		now:      time.Now,
		cache:    make(map[string]basicCacheEntry),
	}
}

func (b *BasicResolver) Name() string { return "basic" }

// Challenge makes Finder / the Windows WebClient pop their native credential
// dialog — the only "login UI" a stock OS mount client has.
func (b *BasicResolver) Challenge() string { return `Basic realm="Grid Drive"` }

type mountAuthReq struct {
	Username string `json:"username"`
	Secret   string `json:"secret"`
}

type mountAuthResp struct {
	Allow          bool   `json:"allow"`
	UserID         string `json:"userId"`
	OrganizationID string `json:"organizationId"`
}

// cacheKey never stores the credential itself — only a digest keyed lookup.
func cacheKey(user, pass string) string {
	sum := sha256.Sum256([]byte(user + "\x00" + pass))
	return hex.EncodeToString(sum[:])
}

func (b *BasicResolver) Resolve(r *http.Request) (authz.Subject, error) {
	user, pass, ok := r.BasicAuth()
	if !ok || user == "" || pass == "" {
		return authz.Subject{}, ErrUnauthenticated
	}
	key := cacheKey(user, pass)

	b.mu.Lock()
	if e, hit := b.cache[key]; hit && b.now().Before(e.expires) {
		b.mu.Unlock()
		if e.allow {
			return e.subject, nil
		}
		return authz.Subject{}, ErrUnauthenticated
	}
	b.mu.Unlock()

	subj, allow, err := b.verify(r.Context(), user, pass)
	if err != nil {
		// Verifier unavailable: NOT cached (the next request retries) and NOT
		// ErrUnauthenticated (the handler answers 503, not a re-prompting 401).
		return authz.Subject{}, err
	}

	b.store(key, subj, allow)
	if !allow {
		return authz.Subject{}, ErrUnauthenticated
	}
	return subj, nil
}

func (b *BasicResolver) verify(ctx context.Context, user, pass string) (authz.Subject, bool, error) {
	body, _ := json.Marshal(mountAuthReq{Username: user, Secret: pass})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint, bytes.NewReader(body))
	if err != nil {
		return authz.Subject{}, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-grid-internal-token", b.token)

	resp, err := b.http.Do(req)
	if err != nil {
		return authz.Subject{}, false, fmt.Errorf("mount-auth: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// The endpoint answers 200 {allow} for both grant and deny; any non-200
		// is an auth/transport failure of the verifier itself. Surfaced as an
		// error → 503, never as a silent deny (the lesson of bug B1).
		return authz.Subject{}, false, fmt.Errorf("mount-auth: status %d", resp.StatusCode)
	}
	var out mountAuthResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return authz.Subject{}, false, fmt.Errorf("mount-auth decode: %w", err)
	}
	if !out.Allow || out.UserID == "" {
		return authz.Subject{}, false, nil
	}
	return authz.Subject{ID: out.UserID, OrgID: out.OrganizationID, Env: b.env}, true, nil
}

func (b *BasicResolver) store(key string, subj authz.Subject, allow bool) {
	ttl := b.negTTL
	if allow {
		ttl = b.posTTL
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.cache) >= basicCacheMax {
		// Sweep expired entries; if the cache is still full (pathological), skip
		// caching this verdict — correctness never depends on the cache.
		now := b.now()
		for k, e := range b.cache {
			if !now.Before(e.expires) {
				delete(b.cache, k)
			}
		}
		if len(b.cache) >= basicCacheMax {
			return
		}
	}
	b.cache[key] = basicCacheEntry{subject: subj, allow: allow, expires: b.now().Add(ttl)}
}

var _ HTTPResolver = (*BasicResolver)(nil)
