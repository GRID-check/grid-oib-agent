package storage

import (
	"context"
	"os"
	"time"

	"gridnas/gateway/internal/authz"
)

// Guard implements StoragePort by authorizing every operation against the authz
// Engine and then delegating to a raw Backend. It is the single choke point where
// storage access meets authorization.
//
// Compile-time safety: Guard must implement every StoragePort method. Adding a
// method to StoragePort without an authorize() call here will not compile the
// missing method / will surface immediately in review -- the write path cannot be
// left unguarded by omission, which was the PoC's structural hazard.
type Guard struct {
	backend Backend
	engine  *authz.Engine
}

func NewGuard(b Backend, e *authz.Engine) *Guard { return &Guard{backend: b, engine: e} }

// authorize is the one place path -> object -> decision happens.
func (g *Guard) authorize(ctx context.Context, subj authz.Subject, rel authz.Relation, path string) error {
	ok, err := g.engine.Authorize(ctx, authz.FileOp{
		Subject:  subj,
		Relation: rel,
		Object:   authz.ObjectFor(path),
	})
	if err != nil {
		return err
	}
	if !ok {
		return os.ErrPermission
	}
	return nil
}

func (g *Guard) Root() string { return g.backend.Root() }

// --- reads (Viewer) ---

func (g *Guard) Open(ctx context.Context, subj authz.Subject, path string) (File, error) {
	if err := g.authorize(ctx, subj, authz.Viewer, path); err != nil {
		return nil, err
	}
	return g.backend.OpenFile(path, os.O_RDONLY, 0)
}

func (g *Guard) Stat(ctx context.Context, subj authz.Subject, path string) (os.FileInfo, error) {
	if err := g.authorize(ctx, subj, authz.Viewer, path); err != nil {
		return nil, err
	}
	return g.backend.Stat(path)
}

func (g *Guard) Lstat(ctx context.Context, subj authz.Subject, path string) (os.FileInfo, error) {
	if err := g.authorize(ctx, subj, authz.Viewer, path); err != nil {
		return nil, err
	}
	return g.backend.Lstat(path)
}

func (g *Guard) Readlink(ctx context.Context, subj authz.Subject, path string) (string, error) {
	if err := g.authorize(ctx, subj, authz.Viewer, path); err != nil {
		return "", err
	}
	return g.backend.Readlink(path)
}

// List authorizes the directory itself for traversal, then batch-filters children
// so a subject only SEES entries it may view (ADR-3: one round-trip, warms cache).
func (g *Guard) List(ctx context.Context, subj authz.Subject, path string) ([]os.FileInfo, error) {
	if err := g.authorize(ctx, subj, authz.Viewer, path); err != nil {
		return nil, err
	}
	entries, err := g.backend.ReadDir(path)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	byName := make(map[string]os.FileInfo, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
		byName[e.Name()] = e
	}
	viewable, err := g.engine.FilterViewable(ctx, subj, names, func(name string) string {
		return authz.ObjectFor(joinPath(path, name))
	})
	if err != nil {
		return nil, err
	}
	out := make([]os.FileInfo, 0, len(entries))
	for name, ok := range viewable {
		if ok {
			out = append(out, byName[name])
		}
	}
	return out, nil
}

// --- mutations (Editor) ---

func (g *Guard) Create(ctx context.Context, subj authz.Subject, path string, flag int, perm os.FileMode) (File, error) {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return nil, err
	}
	return g.backend.OpenFile(path, flag, perm)
}

func (g *Guard) Remove(ctx context.Context, subj authz.Subject, path string) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.Remove(path)
}

func (g *Guard) Rename(ctx context.Context, subj authz.Subject, oldPath, newPath string) error {
	// Both source and destination must be writable by the subject.
	if err := g.authorize(ctx, subj, authz.Editor, oldPath); err != nil {
		return err
	}
	if err := g.authorize(ctx, subj, authz.Editor, newPath); err != nil {
		return err
	}
	return g.backend.Rename(oldPath, newPath)
}

func (g *Guard) Mkdir(ctx context.Context, subj authz.Subject, path string, perm os.FileMode) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.MkdirAll(path, perm)
}

func (g *Guard) Symlink(ctx context.Context, subj authz.Subject, target, link string) error {
	if err := g.authorize(ctx, subj, authz.Editor, link); err != nil {
		return err
	}
	return g.backend.Symlink(target, link)
}

func (g *Guard) Chmod(ctx context.Context, subj authz.Subject, path string, mode os.FileMode) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.Chmod(path, mode)
}

func (g *Guard) Chown(ctx context.Context, subj authz.Subject, path string, uid, gid int) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.Chown(path, uid, gid)
}

func (g *Guard) Lchown(ctx context.Context, subj authz.Subject, path string, uid, gid int) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.Lchown(path, uid, gid)
}

func (g *Guard) Chtimes(ctx context.Context, subj authz.Subject, path string, atime, mtime time.Time) error {
	if err := g.authorize(ctx, subj, authz.Editor, path); err != nil {
		return err
	}
	return g.backend.Chtimes(path, atime, mtime)
}

// compile-time assertion that Guard fully satisfies the port.
var _ StoragePort = (*Guard)(nil)
