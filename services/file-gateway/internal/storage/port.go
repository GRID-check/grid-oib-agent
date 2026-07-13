// Package storage defines the gateway's storage seam.
//
// The central design decision (ADR-0/§0): protocol adapters depend on StoragePort
// -- a hand-written interface where EVERY mutating method takes a Subject and is
// authorized -- NOT on a wide third-party filesystem interface. The Guard is the
// sole implementation used in production; it authorizes then delegates to a raw
// Backend. Because Guard must implement every StoragePort method explicitly, a new
// operation cannot be added without an authorization decision: a missed check is a
// compilation error, not a silent runtime bypass. This is what makes the write
// path (Create/Remove/Rename/Mkdir/Chmod/...) impossible to leave unguarded.
package storage

import (
	"context"
	"os"
	"time"

	"gridnas/gateway/internal/authz"
)

// File is a byte-stream handle. Its method set is intentionally identical to the
// underlying billy.File so adapters need no shimming, but naming it here keeps the
// vendor type from leaking into the port's contract.
type File interface {
	Name() string
	Read(p []byte) (int, error)
	ReadAt(p []byte, off int64) (int, error)
	Write(p []byte) (int, error)
	Seek(offset int64, whence int) (int64, error)
	Truncate(size int64) error
	Lock() error
	Unlock() error
	Close() error
}

// StoragePort is the authorized file interface used by every protocol adapter.
// Reads require Viewer; every mutation requires Editor. Root() is metadata about
// the export and is not a protected object.
type StoragePort interface {
	// --- reads (Viewer) ---
	Open(ctx context.Context, subj authz.Subject, path string) (File, error)
	Stat(ctx context.Context, subj authz.Subject, path string) (os.FileInfo, error)
	Lstat(ctx context.Context, subj authz.Subject, path string) (os.FileInfo, error)
	List(ctx context.Context, subj authz.Subject, path string) ([]os.FileInfo, error)
	Readlink(ctx context.Context, subj authz.Subject, path string) (string, error)
	Root() string

	// --- mutations (Editor) ---
	Create(ctx context.Context, subj authz.Subject, path string, flag int, perm os.FileMode) (File, error)
	Remove(ctx context.Context, subj authz.Subject, path string) error
	Rename(ctx context.Context, subj authz.Subject, oldPath, newPath string) error
	Mkdir(ctx context.Context, subj authz.Subject, path string, perm os.FileMode) error
	Symlink(ctx context.Context, subj authz.Subject, target, link string) error
	Chmod(ctx context.Context, subj authz.Subject, path string, mode os.FileMode) error
	Chown(ctx context.Context, subj authz.Subject, path string, uid, gid int) error
	Lchown(ctx context.Context, subj authz.Subject, path string, uid, gid int) error
	Chtimes(ctx context.Context, subj authz.Subject, path string, atime, mtime time.Time) error
}
