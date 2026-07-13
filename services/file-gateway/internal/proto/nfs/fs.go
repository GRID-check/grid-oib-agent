package nfs

import (
	"context"
	"os"
	"path"
	"time"

	billy "github.com/go-git/go-billy/v5"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/storage"
)

// boundFS adapts our authorized StoragePort to the wide billy.Filesystem
// interface that go-nfs requires, for a single mounted subject.
//
// It implements EVERY billy method explicitly and routes each to a gated
// StoragePort call -- there is NO embedded filesystem, so nothing falls through
// unauthorized. If a future go-nfs upgrade widens billy.Filesystem, this type
// stops compiling until the new method is implemented (and thus authorized). That
// compile-time failure is the design's core safety property.
//
// go-nfs's billy calls carry no context.Context, so a per-mount base context is
// held here; threading RPC deadlines through go-nfs is a known limitation of the
// NFSv3 front (see ADR-2 / §4 context-propagation note).
type boundFS struct {
	port storage.StoragePort
	subj authz.Subject
	ctx  context.Context
}

func newBoundFS(port storage.StoragePort, subj authz.Subject) *boundFS {
	return &boundFS{port: port, subj: subj, ctx: context.Background()}
}

func isWrite(flag int) bool {
	return flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_APPEND|os.O_TRUNC) != 0
}

// --- billy.Basic ---

func (f *boundFS) Create(filename string) (billy.File, error) {
	return f.port.Create(f.ctx, f.subj, filename, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
}

func (f *boundFS) Open(filename string) (billy.File, error) {
	return f.port.Open(f.ctx, f.subj, filename)
}

func (f *boundFS) OpenFile(filename string, flag int, perm os.FileMode) (billy.File, error) {
	if isWrite(flag) {
		return f.port.Create(f.ctx, f.subj, filename, flag, perm)
	}
	return f.port.Open(f.ctx, f.subj, filename)
}

func (f *boundFS) Stat(filename string) (os.FileInfo, error) {
	return f.port.Stat(f.ctx, f.subj, filename)
}

func (f *boundFS) Rename(oldpath, newpath string) error {
	return f.port.Rename(f.ctx, f.subj, oldpath, newpath)
}

func (f *boundFS) Remove(filename string) error {
	return f.port.Remove(f.ctx, f.subj, filename)
}

func (f *boundFS) Join(elem ...string) string { return path.Join(elem...) }

// --- billy.Dir ---

func (f *boundFS) ReadDir(p string) ([]os.FileInfo, error) {
	return f.port.List(f.ctx, f.subj, p)
}

func (f *boundFS) MkdirAll(filename string, perm os.FileMode) error {
	return f.port.Mkdir(f.ctx, f.subj, filename, perm)
}

// --- billy.Symlink ---

func (f *boundFS) Lstat(filename string) (os.FileInfo, error) {
	return f.port.Lstat(f.ctx, f.subj, filename)
}

func (f *boundFS) Symlink(target, link string) error {
	return f.port.Symlink(f.ctx, f.subj, target, link)
}

func (f *boundFS) Readlink(link string) (string, error) {
	return f.port.Readlink(f.ctx, f.subj, link)
}

// --- billy.TempFile ---

func (f *boundFS) TempFile(dir, prefix string) (billy.File, error) {
	// Authorized as a write via Create.
	name := path.Join(dir, prefix+"tmp")
	return f.port.Create(f.ctx, f.subj, name, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
}

// --- billy.Chroot ---

// Root reports the export root. go-nfs addresses everything by absolute path from
// this root and never narrows it, so Chroot returns the same view (documented).
func (f *boundFS) Root() string { return "/" }

func (f *boundFS) Chroot(_ string) (billy.Filesystem, error) { return f, nil }

// --- billy.Change (setattr; gated as Editor) ---

func (f *boundFS) Chmod(name string, mode os.FileMode) error {
	return f.port.Chmod(f.ctx, f.subj, name, mode)
}

func (f *boundFS) Lchown(name string, uid, gid int) error {
	return f.port.Lchown(f.ctx, f.subj, name, uid, gid)
}

func (f *boundFS) Chown(name string, uid, gid int) error {
	return f.port.Chown(f.ctx, f.subj, name, uid, gid)
}

func (f *boundFS) Chtimes(name string, atime, mtime time.Time) error {
	return f.port.Chtimes(f.ctx, f.subj, name, atime, mtime)
}

// Compile-time proof boundFS satisfies the interfaces go-nfs needs.
var (
	_ billy.Filesystem = (*boundFS)(nil)
	_ billy.Change     = (*boundFS)(nil)
)
