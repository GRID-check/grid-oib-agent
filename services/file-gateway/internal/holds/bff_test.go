package holds

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gridnas/gateway/internal/authz"
)

func TestObjectKeyFor(t *testing.T) {
	cases := map[string]string{
		"document:org/o/project/p/doc/d/a.pdf": "org/o/project/p/doc/d/a.pdf",
		"/org/o/project/p/doc/d/a.pdf":         "org/o/project/p/doc/d/a.pdf",
		"org/o/project/p/doc/d/a.pdf/":         "org/o/project/p/doc/d/a.pdf",
	}
	for in, want := range cases {
		if got := objectKeyFor(in); got != want {
			t.Fatalf("objectKeyFor(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseOrgProject(t *testing.T) {
	if o, p, ok := parseOrgProject("org/org_acme/project/proj_atlas/doc/d/a.pdf"); !ok || o != "org_acme" || p != "proj_atlas" {
		t.Fatalf("got (%q,%q,%v)", o, p, ok)
	}
	if _, _, ok := parseOrgProject("oib-core/standards.md"); ok {
		t.Fatal("non-project key must not parse")
	}
}

func TestDeletionAllowed(t *testing.T) {
	ctx := context.Background()
	subj := authz.Subject{ID: "alice", OrgID: "org_acme"}
	key := "org/org_acme/project/proj_atlas/doc/d/a.pdf"

	// A BFF that reports the object as deletable, asserting the request shape.
	var gotToken, gotOrg, gotProj, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("x-grid-internal-token")
		var req deletableReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotOrg, gotProj, gotKey = req.OrganizationID, req.ProjectID, req.ObjectKey
		_ = json.NewEncoder(w).Encode(deletableResp{Deletable: true})
	}))
	defer srv.Close()

	b := NewBFF(srv.URL, "secret", 2*time.Second)
	ok, err := b.DeletionAllowed(ctx, subj, "document:"+key)
	if err != nil || !ok {
		t.Fatalf("expected deletable, got ok=%v err=%v", ok, err)
	}
	if gotToken != "secret" {
		t.Fatalf("must send x-grid-internal-token, got %q", gotToken)
	}
	if gotOrg != "org_acme" || gotProj != "proj_atlas" || gotKey != key {
		t.Fatalf("bad request payload: org=%q proj=%q key=%q", gotOrg, gotProj, gotKey)
	}

	// A held object → deletable:false is passed through (not an error).
	held := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(deletableResp{Deletable: false})
	}))
	defer held.Close()
	if ok, err := NewBFF(held.URL, "secret", time.Second).DeletionAllowed(ctx, subj, key); err != nil || ok {
		t.Fatalf("held object must be not-deletable without error, got ok=%v err=%v", ok, err)
	}
}

func TestDeletionAllowedFailsClosed(t *testing.T) {
	ctx := context.Background()
	subj := authz.Subject{ID: "alice", OrgID: "org_acme"}
	key := "org/org_acme/project/proj_atlas/doc/d/a.pdf"

	// Non-200 → error (Guard.Remove then refuses the delete).
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer bad.Close()
	if _, err := NewBFF(bad.URL, "secret", time.Second).DeletionAllowed(ctx, subj, key); err == nil {
		t.Fatal("non-200 must error (fail closed)")
	}

	// Unparseable key → error without any HTTP call.
	b := NewBFF("http://unused.invalid", "secret", time.Second)
	if _, err := b.DeletionAllowed(ctx, subj, "oib-core/standards.md"); err == nil {
		t.Fatal("unparseable key must error (fail closed)")
	}

	// Cross-tenant mount → error without querying the BFF.
	if _, err := b.DeletionAllowed(ctx, authz.Subject{ID: "alice", OrgID: "org_other"}, key); err == nil {
		t.Fatal("org mismatch must error (fail closed)")
	}
}
