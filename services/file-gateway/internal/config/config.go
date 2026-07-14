// Package config loads typed configuration from the environment and validates it
// at boot. Validation FAILS FAST: a misconfiguration that would weaken security —
// the dev share-per-subject resolver in a prod environment, or a missing internal
// token when delegating to the BFF — prevents startup rather than silently
// degrading.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Env          string // "dev" | "staging" | "prod"
	ListenNFS    string // e.g. ":2049"
	ListenAdmin  string // health + metrics, e.g. ":9090"
	ListenWebDAV string // e.g. ":8090"; empty = WebDAV front disabled (NFS is the default front)

	DataDir string // the (rclone-mounted) storage directory for the billy backend

	// PolicyMode selects the authorization source:
	//   "bff"    — delegate to the Next.js BFF internal endpoint (single authz brain; default)
	//   "workos" — call WorkOS FGA directly (endpoint + api key)
	//   "mock"   — in-process warrants (dev/CI/e2e only)
	PolicyMode string

	// bff mode
	BFFEndpoint     string // http://frontend:3000/api/internal/file-access
	BFFDeletableURL string // http://frontend:3000/api/internal/file-deletable (legal-hold gate)
	InternalToken   string // GRID_INTERNAL_API_TOKEN, shared with the BFF/purger

	// workos mode
	PolicyEndpoint string
	PolicyAPIKey   string

	PolicyTimeout time.Duration

	// Shared decision cache (Dragonfly / Redis-protocol). Empty = L1 only.
	RedisURL       string
	SharedCacheTTL time.Duration

	IdentityResolver string // "dirpath" (dev) | "mounttoken" (prod) | "kerberos" | "smb"

	// L1 (in-process) cache.
	CacheSize  int
	CacheTTL   time.Duration
	CacheGrace time.Duration
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getdur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func getint(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load reads config from the environment and applies defaults. Storage/identity
// env names follow the repo's conventions (REDIS_URL, GRID_INTERNAL_API_TOKEN)
// so the service drops into the existing compose stack.
func Load() Config {
	return Config{
		Env:              getenv("GATEWAY_ENV", "dev"),
		ListenNFS:        getenv("GATEWAY_LISTEN_NFS", ":2049"),
		ListenAdmin:      getenv("GATEWAY_LISTEN_ADMIN", ":9090"),
		ListenWebDAV:     getenv("GATEWAY_WEBDAV_LISTEN", ""),
		DataDir:          getenv("GATEWAY_DATA_DIR", "/data"),
		PolicyMode:       getenv("GATEWAY_POLICY_MODE", "bff"),
		BFFEndpoint:      getenv("GATEWAY_BFF_AUTHZ_URL", "http://frontend:3000/api/internal/file-access"),
		BFFDeletableURL:  getenv("GATEWAY_BFF_DELETABLE_URL", "http://frontend:3000/api/internal/file-deletable"),
		InternalToken:    os.Getenv("GRID_INTERNAL_API_TOKEN"),
		PolicyEndpoint:   getenv("GATEWAY_POLICY_ENDPOINT", ""),
		PolicyAPIKey:     os.Getenv("WORKOS_API_KEY"),
		PolicyTimeout:    getdur("GATEWAY_POLICY_TIMEOUT", 3*time.Second),
		RedisURL:         os.Getenv("REDIS_URL"),
		SharedCacheTTL:   getdur("GATEWAY_SHARED_CACHE_TTL", 30*time.Second),
		IdentityResolver: getenv("GATEWAY_IDENTITY_RESOLVER", "dirpath"),
		CacheSize:        getint("GATEWAY_CACHE_SIZE", 50000),
		CacheTTL:         getdur("GATEWAY_CACHE_TTL", 2*time.Second),
		CacheGrace:       getdur("GATEWAY_CACHE_GRACE", 10*time.Second),
	}
}

// Validate rejects insecure or incomplete configurations at boot.
func (c Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("config: GATEWAY_DATA_DIR is required")
	}
	if c.CacheSize <= 0 {
		return errors.New("config: GATEWAY_CACHE_SIZE must be > 0 (unbounded cache is not allowed)")
	}
	if c.CacheTTL <= 0 {
		return errors.New("config: GATEWAY_CACHE_TTL must be > 0")
	}

	switch c.PolicyMode {
	case "bff":
		if c.BFFEndpoint == "" {
			return errors.New("config: GATEWAY_BFF_AUTHZ_URL is required in bff mode")
		}
		if c.InternalToken == "" {
			return errors.New("config: GRID_INTERNAL_API_TOKEN is required in bff mode")
		}
		// Mirror the BFF's guard: the well-known dev default must never be used
		// outside dev (frontends/ui/src/lib/internal-auth.ts refuses it too).
		if c.Env != "dev" && c.InternalToken == "grid-internal-dev-token" {
			return errors.New("config: refusing the dev-default GRID_INTERNAL_API_TOKEN outside dev")
		}
	case "workos":
		if c.PolicyEndpoint == "" {
			return errors.New("config: GATEWAY_POLICY_ENDPOINT is required in workos mode")
		}
		// A real WorkOS tenant needs an API key; a dev endpoint (mock service) does not.
		if c.Env != "dev" && c.PolicyAPIKey == "" {
			return fmt.Errorf("config: WORKOS_API_KEY is required in workos mode when GATEWAY_ENV=%q", c.Env)
		}
	default:
		return fmt.Errorf("config: unknown GATEWAY_POLICY_MODE %q", c.PolicyMode)
	}

	// Keep this in lockstep with buildResolver() in cmd/gateway: only accept
	// resolvers that are actually implemented, so a misconfig fails at config
	// time with a clear message instead of at wiring time.
	switch c.IdentityResolver {
	case "dirpath":
		if c.Env != "dev" {
			return fmt.Errorf("config: identity resolver %q is dev-only but GATEWAY_ENV=%q", c.IdentityResolver, c.Env)
		}
	case "mounttoken", "kerberos", "smb":
		return fmt.Errorf("config: identity resolver %q is not implemented yet "+
			"(only \"dirpath\" (dev) is available); production identity is a follow-up", c.IdentityResolver)
	default:
		return fmt.Errorf("config: unknown identity resolver %q", c.IdentityResolver)
	}

	// The WebDAV front (additive to NFS) currently authenticates only via the
	// dev-only X-Grid-* header resolver. Like the dirpath resolver, it is
	// client-asserted and spoofable, so it must never run outside dev. Production
	// WebDAV identity (validated Bearer/WorkOS access token via JWKS, or a
	// BFF-issued signed mount token) is a follow-up seam — see proto/webdav.
	if c.ListenWebDAV != "" && c.Env != "dev" {
		return fmt.Errorf("config: GATEWAY_WEBDAV_LISTEN is set but the only WebDAV "+
			"identity resolver is the dev-only header resolver, and GATEWAY_ENV=%q; "+
			"a validated-token resolver is required before enabling WebDAV outside dev", c.Env)
	}
	return nil
}
