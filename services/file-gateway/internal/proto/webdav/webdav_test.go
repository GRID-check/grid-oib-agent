package webdav

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/storage"
)

// --- fakes: a StoragePort with a per-(subject,path) allow predicate, mirroring
// how the real Guard authorizes each op. It lets the test assert that WebDAV ops
// are gated per file for the resolved Subject without standing up the Engine. ---

type fakeInfo struct {
	name string
	size int64
	dir  bool
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return f.size }
func (f fakeInfo) Mode() os.FileMode  { return 0 }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.dir }
func (f fakeInfo) Sys() any           { return nil }

type fakeFile struct {
	name string
	r    *bytes.Reader
}

func (f *fakeFile) Name() string                            { return f.name }
func (f *fakeFile) Read(p []byte) (int, error)              { return f.r.Read(p) }
func (f *fakeFile) ReadAt(p []byte, off int64) (int, error) { return f.r.ReadAt(p, off) }
func (f *fakeFile) Write([]byte) (int, error)               { return 0, os.ErrInvalid }
func (f *fakeFile) Seek(o int64, w int) (int64, error)      { return f.r.Seek(o, w) }
func (f *fakeFile) Truncate(int64) error                    { return nil }
func (f *fakeFile) Lock() error                             { return nil }
func (f *fakeFile) Unlock() error                           { return nil }
func (f *fakeFile) Close() error                            { return nil }

// files present in the fake export.
var fakeFiles = map[string]string{
	"/allowed.txt": "hello world",
	"/secret.txt":  "top secret",
}

type fakePort struct {
	allow func(subj authz.Subject, p string) bool
}

func (p *fakePort) authorized(subj authz.Subject, pth string) bool {
	if pth == "/" || pth == "" { // export root is never gated (matches authz.ObjectFor)
		return true
	}
	return p.allow(subj, pth)
}

func (p *fakePort) Root() string { return "/" }

func (p *fakePort) Stat(_ context.Context, subj authz.Subject, pth string) (os.FileInfo, error) {
	if !p.authorized(subj, pth) {
		return nil, os.ErrPermission
	}
	if pth == "/" || pth == "" {
		return fakeInfo{name: "/", dir: true}, nil
	}
	if body, ok := fakeFiles[pth]; ok {
		return fakeInfo{name: path.Base(pth), size: int64(len(body))}, nil
	}
	return nil, os.ErrNotExist
}

func (p *fakePort) Lstat(ctx context.Context, subj authz.Subject, pth string) (os.FileInfo, error) {
	return p.Stat(ctx, subj, pth)
}

func (p *fakePort) Open(_ context.Context, subj authz.Subject, pth string) (storage.File, error) {
	if !p.authorized(subj, pth) {
		return nil, os.ErrPermission
	}
	body, ok := fakeFiles[pth]
	if !ok {
		return nil, os.ErrNotExist
	}
	return &fakeFile{name: path.Base(pth), r: bytes.NewReader([]byte(body))}, nil
}

// List filters children the subject may not view, exactly like Guard.List.
func (p *fakePort) List(_ context.Context, subj authz.Subject, pth string) ([]os.FileInfo, error) {
	if !p.authorized(subj, pth) {
		return nil, os.ErrPermission
	}
	var out []os.FileInfo
	for fp, body := range fakeFiles {
		if path.Dir(fp) != pth {
			continue
		}
		if !p.authorized(subj, fp) {
			continue
		}
		out = append(out, fakeInfo{name: path.Base(fp), size: int64(len(body))})
	}
	return out, nil
}

func (p *fakePort) Readlink(context.Context, authz.Subject, string) (string, error) {
	return "", os.ErrInvalid
}

func (p *fakePort) Create(_ context.Context, subj authz.Subject, pth string, _ int, _ os.FileMode) (storage.File, error) {
	if !p.authorized(subj, pth) {
		return nil, os.ErrPermission
	}
	return &fakeFile{name: path.Base(pth), r: bytes.NewReader(nil)}, nil
}

func (p *fakePort) Remove(_ context.Context, subj authz.Subject, pth string) error {
	if !p.authorized(subj, pth) {
		return os.ErrPermission
	}
	return nil
}

func (p *fakePort) Rename(_ context.Context, subj authz.Subject, o, n string) error {
	if !p.authorized(subj, o) || !p.authorized(subj, n) {
		return os.ErrPermission
	}
	return nil
}

func (p *fakePort) Mkdir(_ context.Context, subj authz.Subject, pth string, _ os.FileMode) error {
	if !p.authorized(subj, pth) {
		return os.ErrPermission
	}
	return nil
}

func (p *fakePort) Symlink(context.Context, authz.Subject, string, string) error { return nil }
func (p *fakePort) Chmod(context.Context, authz.Subject, string, os.FileMode) error {
	return nil
}
func (p *fakePort) Chown(context.Context, authz.Subject, string, int, int) error  { return nil }
func (p *fakePort) Lchown(context.Context, authz.Subject, string, int, int) error { return nil }
func (p *fakePort) Chtimes(context.Context, authz.Subject, string, time.Time, time.Time) error {
	return nil
}

var _ storage.StoragePort = (*fakePort)(nil)

// alice may see everything except /secret.txt; bob may see nothing.
func policyPort() *fakePort {
	return &fakePort{allow: func(subj authz.Subject, p string) bool {
		return subj.ID == "alice" && p != "/secret.txt"
	}}
}

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// --- FileSystem-level authorization (the task's minimum bar) ---

func TestFileSystemAuthorizesPerSubject(t *testing.T) {
	fsys := &boundFS{port: policyPort()}
	alice := withSubject(context.Background(), authz.Subject{ID: "alice"})
	bob := withSubject(context.Background(), authz.Subject{ID: "bob"})

	// Stat: allowed for alice, denied (ErrPermission) for bob.
	if _, err := fsys.Stat(alice, "/allowed.txt"); err != nil {
		t.Fatalf("alice Stat allowed path: %v", err)
	}
	if _, err := fsys.Stat(bob, "/allowed.txt"); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("bob Stat must be ErrPermission, got %v", err)
	}
	// alice is denied the specific secret file.
	if _, err := fsys.Stat(alice, "/secret.txt"); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("alice Stat secret must be ErrPermission, got %v", err)
	}

	// OpenFile (read): allowed subject reads the bytes; denied subject is refused.
	f, err := fsys.OpenFile(alice, "/allowed.txt", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("alice OpenFile allowed path: %v", err)
	}
	got, _ := io.ReadAll(f)
	_ = f.Close()
	if string(got) != "hello world" {
		t.Fatalf("unexpected body %q", got)
	}
	if _, err := fsys.OpenFile(bob, "/allowed.txt", os.O_RDONLY, 0); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("bob OpenFile must be ErrPermission, got %v", err)
	}

	// Missing subject (off the request pipeline) fails closed.
	if _, err := fsys.Stat(context.Background(), "/allowed.txt"); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("no-subject Stat must fail closed with ErrPermission, got %v", err)
	}
}

// --- Full WebDAV HTTP: identity flows from headers, authz gates each request ---

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	res, err := NewHeaderResolver("dev")
	if err != nil {
		t.Fatal(err)
	}
	return NewHandler(policyPort(), res, discardLog())
}

func TestWebDAVGetAllowedAndDenied(t *testing.T) {
	h := newTestHandler(t)

	// Allowed: alice GETs a file she may view.
	req := httptest.NewRequest(http.MethodGet, "/allowed.txt", nil)
	req.Header.Set(HeaderUserID, "alice")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("allowed GET: want 200, got %d (%s)", rr.Code, rr.Body.String())
	}
	if rr.Body.String() != "hello world" {
		t.Fatalf("allowed GET body = %q", rr.Body.String())
	}

	// Denied by policy: alice GETs a file she may NOT view -> OpenFile returns
	// ErrPermission, which webdav maps to 404 (existence is not disclosed).
	req = httptest.NewRequest(http.MethodGet, "/secret.txt", nil)
	req.Header.Set(HeaderUserID, "alice")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("denied GET: want 404, got %d", rr.Code)
	}

	// Denied subject: bob may view nothing.
	req = httptest.NewRequest(http.MethodGet, "/allowed.txt", nil)
	req.Header.Set(HeaderUserID, "bob")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("bob GET: want 404, got %d", rr.Code)
	}

	// Unauthenticated: no identity header at all -> 401.
	req = httptest.NewRequest(http.MethodGet, "/allowed.txt", nil)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no-identity GET: want 401, got %d", rr.Code)
	}
}

func TestWebDAVPropfindFiltersUnviewable(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequest("PROPFIND", "/", nil)
	req.Header.Set(HeaderUserID, "alice")
	req.Header.Set("Depth", "1")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusMultiStatus {
		t.Fatalf("PROPFIND: want 207, got %d (%s)", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, "allowed.txt") {
		t.Fatalf("PROPFIND listing should include allowed.txt: %s", body)
	}
	if strings.Contains(body, "secret.txt") {
		t.Fatalf("PROPFIND listing must NOT disclose the unviewable secret.txt: %s", body)
	}
}

func TestHeaderResolverIsDevOnly(t *testing.T) {
	if _, err := NewHeaderResolver("prod"); err == nil {
		t.Fatal("header resolver must refuse to construct outside dev")
	}
	r, err := NewHeaderResolver("dev")
	if err != nil {
		t.Fatalf("dev header resolver should construct: %v", err)
	}
	// No identity header -> ErrUnauthenticated.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := r.Resolve(req); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("missing header must be ErrUnauthenticated, got %v", err)
	}
	// With a user id -> a Subject carrying it and the env.
	req.Header.Set(HeaderUserID, "alice")
	req.Header.Set(HeaderOrgID, "org_acme")
	subj, err := r.Resolve(req)
	if err != nil {
		t.Fatal(err)
	}
	if subj.ID != "alice" || subj.OrgID != "org_acme" || subj.Env != "dev" {
		t.Fatalf("unexpected subject %+v", subj)
	}
}
