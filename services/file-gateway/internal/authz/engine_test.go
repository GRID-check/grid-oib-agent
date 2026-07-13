package authz_test

import (
	"context"
	"testing"
	"time"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/policy"
)

// warrants: alice edits atlas; bob views zenith; both are ACME members.
func testEngine(t *testing.T) *authz.Engine {
	t.Helper()
	mock := policy.NewMock(policy.Warrants{
		Orgs: map[string]map[string]bool{
			"alice": {"org-acme": true},
			"bob":   {"org-acme": true},
		},
		OrgRoles: map[string]map[string]string{
			"alice": {"org-acme": "viewer"},
			"bob":   {"org-acme": "viewer"},
		},
		ProjectRoles: map[string]map[string]string{
			"alice": {"org-acme/atlas": "editor"},
			"bob":   {"org-acme/zenith": "viewer"},
		},
	})
	e, err := authz.New(mock, nil, nil, authz.Config{CacheSize: 1000, CacheTTL: time.Second, CacheGrace: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func obj(p string) string { return authz.ObjectFor(p) }

func TestAuthorizeMatrix(t *testing.T) {
	e := testEngine(t)
	ctx := context.Background()
	alice := authz.Subject{ID: "alice"}
	bob := authz.Subject{ID: "bob"}

	cases := []struct {
		name string
		subj authz.Subject
		rel  authz.Relation
		path string
		want bool
	}{
		// reads
		{"alice reads atlas", alice, authz.Viewer, "org-acme/project-atlas/plan.pdf", true},
		{"bob denied atlas (same file)", bob, authz.Viewer, "org-acme/project-atlas/plan.pdf", false},
		{"bob reads zenith", bob, authz.Viewer, "org-acme/project-zenith/design.pdf", true},
		{"alice denied zenith", alice, authz.Viewer, "org-acme/project-zenith/design.pdf", false},
		{"both read oib-core", alice, authz.Viewer, "oib-core/standards.md", true},

		// WRITES -- the path that was unguarded in the PoC.
		{"alice EDITS atlas", alice, authz.Editor, "org-acme/project-atlas/plan.pdf", true},
		{"bob CANNOT edit atlas", bob, authz.Editor, "org-acme/project-atlas/plan.pdf", false},
		{"bob CANNOT edit zenith (viewer only)", bob, authz.Editor, "org-acme/project-zenith/design.pdf", false},
		{"alice CANNOT edit oib-core (read-only ground truth)", alice, authz.Editor, "oib-core/standards.md", false},
		{"alice CANNOT edit org handbook (viewer at org)", alice, authz.Editor, "org-acme/handbook.md", false},

		// unknown identity
		{"stranger denied", authz.Subject{ID: "mallory"}, authz.Viewer, "oib-core/standards.md", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := e.Authorize(ctx, authz.FileOp{Subject: c.subj, Relation: c.rel, Object: obj(c.path)})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("Authorize(%s,%s,%s) = %v, want %v", c.subj.ID, c.rel, c.path, got, c.want)
			}
		})
	}
}

func TestMountRootAlwaysAllowed(t *testing.T) {
	e := testEngine(t)
	for _, p := range []string{"", "/", ".", "//"} {
		ok, err := e.Authorize(context.Background(), authz.FileOp{
			Subject: authz.Subject{ID: "mallory"}, Relation: authz.Viewer, Object: authz.ObjectFor(p),
		})
		if err != nil || !ok {
			t.Fatalf("root %q must be allowed for traversal, got ok=%v err=%v", p, ok, err)
		}
	}
}

func TestObjectForResistsTraversal(t *testing.T) {
	// A derived object id must not escape the document namespace via "..".
	got := authz.ObjectFor("org-acme/../../etc/passwd")
	if got != "document:etc/passwd" {
		t.Fatalf("path traversal not normalized: %q", got)
	}
	if authz.ObjectFor("../..") != "" { // cleans to root
		t.Fatalf("traversal to root not normalized: %q", authz.ObjectFor("../.."))
	}
}
