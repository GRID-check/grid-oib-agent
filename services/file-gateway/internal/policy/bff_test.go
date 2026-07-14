package policy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseObject(t *testing.T) {
	cases := []struct {
		in        string
		org, proj string
		ok        bool
	}{
		{"document:org/org_acme/project/proj_atlas/doc/d1/plan.pdf", "org_acme", "proj_atlas", true},
		{"org/org_acme/project/proj_atlas/folder/x/doc/d1/plan.pdf", "org_acme", "proj_atlas", true},
		{"document:org/org_acme/project/proj_atlas", "org_acme", "proj_atlas", true},
		{"document:oib-core/standards.md", "", "", false}, // not project-scoped
		{"", "", "", false},
	}
	for _, c := range cases {
		org, proj, ok := parseObject(c.in)
		if ok != c.ok || org != c.org || proj != c.proj {
			t.Fatalf("parseObject(%q) = (%q,%q,%v), want (%q,%q,%v)", c.in, org, proj, ok, c.org, c.proj, c.ok)
		}
	}
}

func TestRelationToPermission(t *testing.T) {
	if relationToPermission("viewer") != "project:view" {
		t.Fatal("viewer should map to project:view")
	}
	if relationToPermission("editor") != "project:edit" {
		t.Fatal("editor should map to project:edit")
	}
}

// Bug #1 regression: in bff mode the client must allow VIEWER traversal of the
// org/project scaffolding above a project (within the caller's own org) so an NFS
// client can descend to a project — while never revealing another tenant's dirs.
// These paths are decided locally, so no BFF is contacted.
func TestBFFAncestorTraversal(t *testing.T) {
	b := NewBFF("http://unused.invalid", "secret", time.Second)
	ctx := context.Background()
	own := Subject{ID: "alice", OrgID: "org_acme"}
	allow := func(rel, obj string) bool { ok, _ := b.Check(ctx, own, rel, obj); return ok }

	for _, o := range []string{"document:org", "document:org/org_acme", "document:org/org_acme/project"} {
		if !allow("viewer", o) {
			t.Fatalf("own-org traversal %q must be allowed so the drive can descend", o)
		}
	}
	if allow("viewer", "document:org/org_evil") {
		t.Fatal("another org's scaffolding must NOT be traversable (tenant existence leak)")
	}
	if allow("viewer", "document:org/org_evil/project") {
		t.Fatal("another org's project dir must NOT be traversable")
	}
	if allow("editor", "document:org/org_acme/project") {
		t.Fatal("a write on a traversal dir must be denied")
	}
}

func TestBFFCheck(t *testing.T) {
	// A fake BFF that authorizes user "alice" on proj_atlas only. It authenticates
	// on the x-grid-internal-token header — the SAME contract as the real
	// internalApiRoute (a Bearer header would 403, the bug this test now guards).
	var sawToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawToken = r.Header.Get("x-grid-internal-token")
		if sawToken != "secret" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var req bffReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		_ = json.NewEncoder(w).Encode(bffResp{Allow: req.UserID == "alice" && req.ProjectID == "proj_atlas"})
	}))
	defer srv.Close()

	b := NewBFF(srv.URL, "secret", 2*time.Second)
	ctx := context.Background()
	atlas := "document:org/org_acme/project/proj_atlas/doc/d1/plan.pdf"

	if ok, _ := b.Check(ctx, Subject{ID: "alice", OrgID: "org_acme"}, "viewer", atlas); !ok {
		t.Fatal("alice should view atlas")
	}
	if sawToken != "secret" {
		t.Fatalf("gateway must send x-grid-internal-token, got %q", sawToken)
	}
	if ok, _ := b.Check(ctx, Subject{ID: "bob", OrgID: "org_acme"}, "viewer", atlas); ok {
		t.Fatal("bob should be denied atlas")
	}
	// mount-org tenancy: a mount scoped to org_other is hard-denied a path under
	// org_acme WITHOUT reaching the BFF (this is the previously-dead check).
	if ok, _ := b.Check(ctx, Subject{ID: "alice", OrgID: "org_other"}, "viewer", atlas); ok {
		t.Fatal("org mismatch must be hard-denied")
	}
	// non-project path is denied without hitting the BFF
	if ok, _ := b.Check(ctx, Subject{ID: "alice"}, "viewer", "document:oib-core/standards.md"); ok {
		t.Fatal("non-project path must be denied (fail closed)")
	}
	// wrong token → non-200 → ERROR (fail closed WITH a signal, not silent deny)
	bad := NewBFF(srv.URL, "wrong", 2*time.Second)
	if _, err := bad.Check(ctx, Subject{ID: "alice", OrgID: "org_acme"}, "viewer", atlas); err == nil {
		t.Fatal("bad token should error (surfaced, not silently denied)")
	}
}
