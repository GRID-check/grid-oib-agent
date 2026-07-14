// Package config loads typed configuration from the environment and validates it
// at boot. Validation FAILS FAST: a misconfiguration that would weaken security —
// the dev header identity in a prod environment, or a missing internal token —
// prevents startup rather than silently degrading.
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
	ListenWebDAV string // the drive front, e.g. ":8090"
	ListenAdmin  string // health + metrics, e.g. ":9090"

	DataDir string // the (rclone-mounted) storage directory for the billy backend

	// The BFF is the single authorization brain (WorkOS FGA + org membership);
	// all three endpoints authenticate with InternalToken.
	BFFEndpoint     string // http://frontend:3000/api/internal/file-access   (per-op authz)
	BFFDeletableURL string // http://frontend:3000/api/internal/file-deletable (legal-hold gate)
	BFFMountAuthURL string // http://frontend:3000/api/internal/mount-auth    (mount identity)
	InternalToken   string // GRID_INTERNAL_API_TOKEN, shared with the BFF/purger

	PolicyTimeout time.Duration

	// WebDAVIdentity selects the HTTP identity resolver:
	//   "header" — dev-only X-Grid-* headers (client-asserted, spoofable)
	//   "basic"  — WebDAV Basic auth verified against the BFF mount-auth
	//              endpoint (SSO-brokered device credentials, ADR-0025). The
	//              production mode; REQUIRES TLS at the ingress.
	WebDAVIdentity string

	// L1 (in-process) decision cache. The BFF owns the shared L2 (Dragonfly).
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

// Load reads config from the environment and applies defaults. Env names follow
// the repo's conventions (GRID_INTERNAL_API_TOKEN) so the service drops into the
// existing compose stack.
func Load() Config {
	return Config{
		Env:             getenv("GATEWAY_ENV", "dev"),
		ListenWebDAV:    getenv("GATEWAY_WEBDAV_LISTEN", ":8090"),
		ListenAdmin:     getenv("GATEWAY_LISTEN_ADMIN", ":9090"),
		DataDir:         getenv("GATEWAY_DATA_DIR", "/data"),
		BFFEndpoint:     getenv("GATEWAY_BFF_AUTHZ_URL", "http://frontend:3000/api/internal/file-access"),
		BFFDeletableURL: getenv("GATEWAY_BFF_DELETABLE_URL", "http://frontend:3000/api/internal/file-deletable"),
		BFFMountAuthURL: getenv("GATEWAY_BFF_MOUNT_AUTH_URL", "http://frontend:3000/api/internal/mount-auth"),
		InternalToken:   os.Getenv("GRID_INTERNAL_API_TOKEN"),
		PolicyTimeout:   getdur("GATEWAY_POLICY_TIMEOUT", 3*time.Second),
		WebDAVIdentity:  getenv("GATEWAY_WEBDAV_IDENTITY", "header"),
		CacheSize:       getint("GATEWAY_CACHE_SIZE", 50000),
		CacheTTL:        getdur("GATEWAY_CACHE_TTL", 2*time.Second),
		CacheGrace:      getdur("GATEWAY_CACHE_GRACE", 10*time.Second),
	}
}

// Validate rejects insecure or incomplete configurations at boot.
func (c Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("config: GATEWAY_DATA_DIR is required")
	}
	if c.ListenWebDAV == "" {
		return errors.New("config: GATEWAY_WEBDAV_LISTEN is required (the WebDAV front IS the drive)")
	}
	if c.CacheSize <= 0 {
		return errors.New("config: GATEWAY_CACHE_SIZE must be > 0 (unbounded cache is not allowed)")
	}
	if c.CacheTTL <= 0 {
		return errors.New("config: GATEWAY_CACHE_TTL must be > 0")
	}

	// The BFF is the only authorization source; without it every op fails closed.
	if c.BFFEndpoint == "" {
		return errors.New("config: GATEWAY_BFF_AUTHZ_URL is required")
	}
	if c.BFFDeletableURL == "" {
		return errors.New("config: GATEWAY_BFF_DELETABLE_URL is required (legal-hold gate for deletes)")
	}
	if c.InternalToken == "" {
		return errors.New("config: GRID_INTERNAL_API_TOKEN is required")
	}
	// Mirror the BFF's guard: the well-known dev default must never be used
	// outside dev (frontends/ui/src/lib/internal-auth.ts refuses it too).
	if c.Env != "dev" && c.InternalToken == "grid-internal-dev-token" {
		return errors.New("config: refusing the dev-default GRID_INTERNAL_API_TOKEN outside dev")
	}

	// WebDAV identity matrix (keep in lockstep with buildWebDAVResolver):
	//   header — client-asserted X-Grid-* headers, spoofable → dev-only.
	//   basic  — SSO-brokered device credentials verified against the BFF
	//            mount-auth endpoint (ADR-0025) → the production mode. TLS is
	//            terminated at the ingress and is a deployment invariant (Basic
	//            is plaintext-equivalent).
	switch c.WebDAVIdentity {
	case "header":
		if c.Env != "dev" {
			return fmt.Errorf("config: GATEWAY_WEBDAV_IDENTITY=header is dev-only "+
				"(client-asserted, spoofable) but GATEWAY_ENV=%q; use \"basic\" "+
				"(SSO-brokered device credentials) outside dev", c.Env)
		}
	case "basic":
		if c.BFFMountAuthURL == "" {
			return errors.New("config: GATEWAY_BFF_MOUNT_AUTH_URL is required for WebDAV basic identity")
		}
	default:
		return fmt.Errorf("config: unknown GATEWAY_WEBDAV_IDENTITY %q (header|basic)", c.WebDAVIdentity)
	}
	return nil
}
