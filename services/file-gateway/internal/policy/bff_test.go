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
		in                string
		org, proj string
		ok                bool
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

func TestBFFCheck(t *testing.T) {
	// A fake BFF that authorizes user "alice" as editor on proj_atlas only.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req bffReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		allow := req.UserID == "alice" && req.ProjectID == "proj_atlas"
		// editor implies view; viewer does not imply edit
		if req.Permission == "project:edit" {
			allow = allow // alice is editor on atlas
		}
		_ = json.NewEncoder(w).Encode(bffResp{Allow: allow})
	}))
	defer srv.Close()

	b := NewBFF(srv.URL, "secret", 2*time.Second)
	ctx := context.Background()

	// alice may view/edit atlas
	if ok, _ := b.Check(ctx, "alice", "viewer", "document:org/org_acme/project/proj_atlas/doc/d1/plan.pdf"); !ok {
		t.Fatal("alice should view atlas")
	}
	// bob may not
	if ok, _ := b.Check(ctx, "bob", "viewer", "document:org/org_acme/project/proj_atlas/doc/d1/plan.pdf"); ok {
		t.Fatal("bob should be denied atlas")
	}
	// non-project path is denied without hitting the BFF
	if ok, _ := b.Check(ctx, "alice", "viewer", "document:oib-core/standards.md"); ok {
		t.Fatal("non-project path must be denied (fail closed)")
	}
	// wrong token surfaces as an error (engine fails closed / grace)
	bad := NewBFF(srv.URL, "wrong", 2*time.Second)
	if _, err := bad.Check(ctx, "alice", "viewer", "document:org/org_acme/project/proj_atlas/doc/d1/x"); err == nil {
		t.Fatal("bad token should error")
	}
}
