package config

import (
	"strings"
	"testing"
	"time"
)

// A minimal valid dev config; each case mutates one axis.
func base() Config {
	return Config{
		Env:             "dev",
		ListenWebDAV:    ":8090",
		DataDir:         "/data",
		BFFEndpoint:     "http://frontend:3000/api/internal/file-access",
		BFFDeletableURL: "http://frontend:3000/api/internal/file-deletable",
		BFFMountAuthURL: "http://frontend:3000/api/internal/mount-auth",
		InternalToken:   "tok",
		PolicyTimeout:   time.Second,
		WebDAVIdentity:  "header",
		CacheSize:       100,
		CacheTTL:        time.Second,
	}
}

// The identity matrix — the seam that decides whether a spoofable resolver can
// ever reach production (ADR-0025).
func TestValidateWebDAVIdentityMatrix(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr string // substring; empty = must pass
	}{
		{"header allowed in dev", func(*Config) {}, ""},
		{"header REFUSED outside dev", func(c *Config) {
			c.Env = "prod"
		}, "dev-only"},
		{"basic allowed in dev", func(c *Config) {
			c.WebDAVIdentity = "basic"
		}, ""},
		{"basic is a VALID production config", func(c *Config) {
			c.Env = "prod"
			c.WebDAVIdentity = "basic"
		}, ""},
		{"basic requires mount-auth URL", func(c *Config) {
			c.WebDAVIdentity = "basic"
			c.BFFMountAuthURL = ""
		}, "GATEWAY_BFF_MOUNT_AUTH_URL"},
		{"unknown identity refused", func(c *Config) {
			c.WebDAVIdentity = "kerberos"
		}, "unknown GATEWAY_WEBDAV_IDENTITY"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mutate(&c)
			err := c.Validate()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

// The BFF is the only authz brain: every endpoint + the internal token are
// hard requirements, and the well-known dev token is refused outside dev.
func TestValidateBFFRequirements(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(*Config)
		wantErr string
	}{
		{"missing authz URL", func(c *Config) { c.BFFEndpoint = "" }, "GATEWAY_BFF_AUTHZ_URL"},
		{"missing deletable URL", func(c *Config) { c.BFFDeletableURL = "" }, "GATEWAY_BFF_DELETABLE_URL"},
		{"missing internal token", func(c *Config) { c.InternalToken = "" }, "GRID_INTERNAL_API_TOKEN"},
		{"missing webdav listen", func(c *Config) { c.ListenWebDAV = "" }, "GATEWAY_WEBDAV_LISTEN"},
		{"dev-default token refused outside dev", func(c *Config) {
			c.Env = "prod"
			c.WebDAVIdentity = "basic"
			c.InternalToken = "grid-internal-dev-token"
		}, "dev-default"},
		{"dev-default token fine IN dev", func(c *Config) {
			c.InternalToken = "grid-internal-dev-token"
		}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mutate(&c)
			err := c.Validate()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}
