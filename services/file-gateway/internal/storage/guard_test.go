package storage

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/policy"
)

// --- fakes ---

type fakePolicy struct {
	allow func(rel, object string) bool
}

func (f fakePolicy) Check(_ context.Context, _ policy.Subject, rel, object string) (bool, error) {
	return f.allow(rel, object), nil
}
func (f fakePolicy) BatchCheck(_ context.Context, _ policy.Subject, rel string, objects []string) (map[string]bool, error) {
	out := make(map[string]bool, len(objects))
	for _, o := range objects {
		out[o] = f.allow(rel, o)
	}
	return out, nil
}

type fakeInfo struct {
	name string
	dir  bool
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64         { return 0 }
func (f fakeInfo) Mode() os.FileMode   { return 0 }
func (f fakeInfo) ModTime() time.Time  { return time.Time{} }
func (f fakeInfo) IsDir() bool         { return f.dir }
func (f fakeInfo) Sys() any            { return nil }

// fakeBackend records the last mutating call so tests can assert the backend was
// (not) reached, and serves a fixed directory listing.
type fakeBackend struct {
	entries   []os.FileInfo
	lastWrite string
}

func (b *fakeBackend) OpenFile(path string, _ int, _ os.FileMode) (File, error) {
	b.lastWrite = "openfile:" + path
	return nil, nil
}
func (b *fakeBackend) Stat(string) (os.FileInfo, error)  { return fakeInfo{}, nil }
func (b *fakeBackend) Lstat(string) (os.FileInfo, error) { return fakeInfo{}, nil }
func (b *fakeBackend) ReadDir(string) ([]os.FileInfo, error) {
	return b.entries, nil
}
func (b *fakeBackend) Remove(path string) error { b.lastWrite = "remove:" + path; return nil }
func (b *fakeBackend) Rename(o, n string) error { b.lastWrite = "rename:" + o + "->" + n; return nil }
func (b *fakeBackend) MkdirAll(path string, _ os.FileMode) error {
	b.lastWrite = "mkdir:" + path
	return nil
}
func (b *fakeBackend) Symlink(_, link string) error { b.lastWrite = "symlink:" + link; return nil }
func (b *fakeBackend) Readlink(string) (string, error)          { return "", nil }
func (b *fakeBackend) Chmod(string, os.FileMode) error          { return nil }
func (b *fakeBackend) Chown(string, int, int) error             { return nil }
func (b *fakeBackend) Lchown(string, int, int) error            { return nil }
func (b *fakeBackend) Chtimes(string, time.Time, time.Time) error { return nil }
func (b *fakeBackend) Root() string                            { return "/" }

func newGuard(t *testing.T, backend *fakeBackend, allow func(rel, object string) bool) *Guard {
	t.Helper()
	eng, err := authz.New(fakePolicy{allow: allow}, nil, nil, authz.Config{
		CacheSize: 100, CacheTTL: time.Second, CacheGrace: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewGuard(backend, eng)
}

var subj = authz.Subject{ID: "alice", OrgID: "org_acme"}

// Reads require viewer; a deny surfaces as ErrPermission and never touches storage.
func TestGuardReadRequiresViewer(t *testing.T) {
	be := &fakeBackend{}
	g := newGuard(t, be, func(rel, _ string) bool { return rel == "viewer" })

	if _, err := g.Open(context.Background(), subj, "org/org_acme/project/p/doc/d/a.pdf"); err != nil {
		t.Fatalf("viewer should be allowed to Open: %v", err)
	}

	deny := newGuard(t, be, func(string, string) bool { return false })
	be.lastWrite = ""
	if _, err := deny.Open(context.Background(), subj, "org/org_acme/project/p/doc/d/a.pdf"); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("denied Open must be ErrPermission, got %v", err)
	}
	if be.lastWrite != "" {
		t.Fatalf("denied Open must not touch the backend, touched %q", be.lastWrite)
	}
}

// Mutations require editor — a viewer-only subject cannot Create/Remove/Mkdir.
func TestGuardMutationsRequireEditor(t *testing.T) {
	be := &fakeBackend{}
	viewerOnly := newGuard(t, be, func(rel, _ string) bool { return rel == "viewer" })
	ctx := context.Background()
	p := "org/org_acme/project/p/doc/d/a.pdf"

	be.lastWrite = ""
	if _, err := viewerOnly.Create(ctx, subj, p, os.O_CREATE|os.O_WRONLY, 0644); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("viewer Create must be denied, got %v", err)
	}
	if err := viewerOnly.Remove(ctx, subj, p); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("viewer Remove must be denied, got %v", err)
	}
	if err := viewerOnly.Mkdir(ctx, subj, "org/org_acme/project/p/folder", 0755); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("viewer Mkdir must be denied, got %v", err)
	}
	if be.lastWrite != "" {
		t.Fatalf("no denied mutation may reach the backend, reached %q", be.lastWrite)
	}
}

// Rename requires editor on BOTH source and destination.
func TestGuardRenameRequiresEditorOnBothPaths(t *testing.T) {
	be := &fakeBackend{}
	ctx := context.Background()
	src := "org/org_acme/project/p/doc/d/a.pdf"
	dstOK := "org/org_acme/project/p/doc/d/b.pdf"
	dstForbidden := "org/org_acme/project/other/doc/d/b.pdf"

	// editor everywhere except the "other" project dest.
	g := newGuard(t, be, func(rel, obj string) bool {
		return rel == "editor" && obj != "document:org/org_acme/project/other/doc/d/b.pdf"
	})

	if err := g.Rename(ctx, subj, src, dstOK); err != nil {
		t.Fatalf("editor on both paths should allow rename: %v", err)
	}
	be.lastWrite = ""
	if err := g.Rename(ctx, subj, src, dstForbidden); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("rename into a dir the subject can't edit must be denied, got %v", err)
	}
	if be.lastWrite != "" {
		t.Fatalf("denied rename must not reach the backend, reached %q", be.lastWrite)
	}
}

// List returns only the children the subject may view.
func TestGuardListFiltersUnviewable(t *testing.T) {
	be := &fakeBackend{entries: []os.FileInfo{
		fakeInfo{name: "visible.pdf"},
		fakeInfo{name: "secret.pdf"},
		fakeInfo{name: "sub", dir: true},
	}}
	// viewer may see everything except secret.pdf.
	g := newGuard(t, be, func(rel, obj string) bool {
		return rel == "viewer" && obj != "document:org/org_acme/project/p/secret.pdf"
	})

	infos, err := g.List(context.Background(), subj, "org/org_acme/project/p")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, i := range infos {
		got[i.Name()] = true
	}
	if got["secret.pdf"] {
		t.Fatal("List must hide children the subject cannot view")
	}
	if !got["visible.pdf"] || !got["sub"] {
		t.Fatalf("List dropped viewable children: %v", got)
	}
}
