package storage

import (
	"os"
	"time"

	billy "github.com/go-git/go-billy/v5"
	"github.com/go-git/go-billy/v5/osfs"
)

// billyBackend is the phase-1 Backend: it serves a local directory that is an
// rclone FUSE mount of the S3 bucket. Reads/writes to the directory become S3
// GET/PUT via rclone. This is a bridge (ADR-1); the native aws-sdk-go-v2 backend
// will replace it behind the same Backend interface, dropping the FUSE/privilege
// requirement -- without touching the Guard, Engine, or protocol adapters.
type billyBackend struct {
	fs     billy.Filesystem
	change billy.Change // nil if the underlying fs does not support metadata ops
}

// NewBillyFUSEBackend serves the given mount directory.
func NewBillyFUSEBackend(mountDir string) Backend {
	fs := osfs.New(mountDir)
	b := &billyBackend{fs: fs}
	if c, ok := fs.(billy.Change); ok {
		b.change = c
	}
	return b
}

func (b *billyBackend) OpenFile(path string, flag int, perm os.FileMode) (File, error) {
	// billy.File's method set matches storage.File exactly.
	return b.fs.OpenFile(path, flag, perm)
}
func (b *billyBackend) Stat(path string) (os.FileInfo, error)  { return b.fs.Stat(path) }
func (b *billyBackend) Lstat(path string) (os.FileInfo, error) { return b.fs.Lstat(path) }
func (b *billyBackend) ReadDir(path string) ([]os.FileInfo, error) {
	return b.fs.ReadDir(path)
}
func (b *billyBackend) Remove(path string) error { return b.fs.Remove(path) }
func (b *billyBackend) Rename(oldPath, newPath string) error {
	return b.fs.Rename(oldPath, newPath)
}
func (b *billyBackend) MkdirAll(path string, perm os.FileMode) error {
	return b.fs.MkdirAll(path, perm)
}
func (b *billyBackend) Symlink(target, link string) error { return b.fs.Symlink(target, link) }
func (b *billyBackend) Readlink(path string) (string, error) {
	return b.fs.Readlink(path)
}
func (b *billyBackend) Root() string { return b.fs.Root() }

func (b *billyBackend) Chmod(path string, mode os.FileMode) error {
	if b.change == nil {
		return billy.ErrNotSupported
	}
	return b.change.Chmod(path, mode)
}
func (b *billyBackend) Chown(path string, uid, gid int) error {
	if b.change == nil {
		return billy.ErrNotSupported
	}
	return b.change.Chown(path, uid, gid)
}
func (b *billyBackend) Lchown(path string, uid, gid int) error {
	if b.change == nil {
		return billy.ErrNotSupported
	}
	return b.change.Lchown(path, uid, gid)
}
func (b *billyBackend) Chtimes(path string, atime, mtime time.Time) error {
	if b.change == nil {
		return billy.ErrNotSupported
	}
	return b.change.Chtimes(path, atime, mtime)
}

var _ Backend = (*billyBackend)(nil)
