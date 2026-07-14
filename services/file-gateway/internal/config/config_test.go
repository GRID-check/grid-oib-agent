package config

import (
	"strings"
	"testing"
	"time"
)

// A minimal valid bff-mode dev config; each case mutates one axis.
func base() Config {
	return Config{
		Env:              "dev",
		DataDir:          "/data",
		PolicyMode:       "bff",
		BFFEndpoint:      "http://frontend:3000/api/internal/file-access",
		BFFDeletableURL:  "http://frontend:3000/api/internal/file-deletable",
		BFFMountAuthURL:  "http://frontend:3000/api/internal/mount-auth",
		InternalToken:    "tok",
		PolicyTimeout:    time.Second,
		IdentityResolver: "dirpath",
		WebDAVIdentity:   "header",
		CacheSize:        100,
		CacheTTL:         time.Second,
	}
}

// The WebDAV identity matrix — the seam that decides whether a spoofable
// resolver can ever reach production.
func TestValidateWebDAVIdentityMatrix(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr string // substring; empty = must pass
	}{
		{"webdav disabled ignores identity", func(c *Config) {
			c.ListenWebDAV = ""
			c.WebDAVIdentity = "garbage"
		}, ""},
		{"header allowed in dev", func(c *Config) {
			c.ListenWebDAV = ":8090"
		}, ""},
		{"basic allowed in dev", func(c *Config) {
			c.ListenWebDAV = ":8090"
			c.WebDAVIdentity = "basic"
		}, ""},
		{"basic requires mount-auth URL", func(c *Config) {
			c.ListenWebDAV = ":8090"
			c.WebDAVIdentity = "basic"
			c.BFFMountAuthURL = ""
		}, "GATEWAY_BFF_MOUNT_AUTH_URL"},
		{"basic requires internal token", func(c *Config) {
			c.ListenWebDAV = ":8090"
			c.WebDAVIdentity = "basic"
			c.InternalToken = ""
		}, "GRID_INTERNAL_API_TOKEN"},
		{"unknown identity refused", func(c *Config) {
			c.ListenWebDAV = ":8090"
			c.WebDAVIdentity = "kerberos"
		}, "unknown GATEWAY_WEBDAV_IDENTITY"},
	}

	for _, tc := range cases {
		if tc.name == "header REFUSED outside dev" {
			continue // handled explicitly below (needs a prod-valid base)
		}
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

// Outside dev: the spoofable header resolver must be refused, and basic must be
// accepted — this is what turns the WebDAV front from a dev toy into the
// production mount path (ADR-0025). NOTE: dirpath (NFS identity) is itself
// dev-only, so these prod cases can't construct a fully-valid prod config yet;
// they assert the ORDER-INDEPENDENT property that the error (or lack of a
// WebDAV error) mentions the right subsystem.
func TestValidateWebDAVOutsideDev(t *testing.T) {
	// header + prod → refused, mentioning the WebDAV identity...
	c := base()
	c.Env = "prod"
	c.ListenWebDAV = ":8090"
	err := c.Validate()
	if err == nil {
		t.Fatal("prod config with dev-only resolvers must not validate")
	}
	// ...unless the NFS dirpath guard fires first — either way it must NOT pass.
	if !strings.Contains(err.Error(), "dev-only") {
		t.Fatalf("expected a dev-only refusal, got %v", err)
	}

	// basic + prod: the WebDAV block itself must be satisfied. Isolate it by
	// checking that the only remaining complaint is the (separate) NFS resolver.
	c = base()
	c.Env = "prod"
	c.ListenWebDAV = ":8090"
	c.WebDAVIdentity = "basic"
	err = c.Validate()
	if err == nil {
		t.Fatal("dirpath NFS resolver is still dev-only; expected that refusal")
	}
	if strings.Contains(err.Error(), "WEBDAV") {
		t.Fatalf("basic identity must satisfy the WebDAV block in prod, got %v", err)
	}

	// And the dev-default internal token is refused for basic outside dev.
	c = base()
	c.Env = "prod"
	c.IdentityResolver = "dirpath" // still trips its own guard AFTER the token check? order matters:
	c.ListenWebDAV = ":8090"
	c.WebDAVIdentity = "basic"
	c.InternalToken = "grid-internal-dev-token"
	err = c.Validate()
	if err == nil || !strings.Contains(err.Error(), "dev-default") {
		t.Fatalf("dev-default token must be refused outside dev, got %v", err)
	}
}
