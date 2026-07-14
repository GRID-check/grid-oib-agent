package webdav

import (
	"context"
	"io"
	"os"

	xwebdav "golang.org/x/net/webdav"

	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/storage"
)

// boundFS adapts our authorized StoragePort to golang.org/x/net/webdav.FileSystem.
// Unlike the NFS boundFS, identity is NOT bound per-instance: a single boundFS
// serves every caller, and each method pulls the Subject from the request context
// (stashed by the Handler). This mirrors HTTP's per-request identity model while
// keeping the exact same StoragePort authorization on every operation.
//
// It implements EVERY webdav.FileSystem method explicitly and routes each to a
// gated StoragePort call — there is no embedded filesystem, so nothing falls
// through unauthorized. A denial surfaces from the Guard as os.ErrPermission and
// is passed through unchanged, which webdav maps to a 4xx (404 for GET/PUT via
// OpenFile; MKCOL/DELETE/PROPFIND to 405) — existence is never leaked as a
// distinct 403.
type boundFS struct {
	port storage.StoragePort
}

// subject fails closed: if the Handler did not stash a Subject (only possible off
// the request path), every op is denied rather than served unauthenticated.
func subject(ctx context.Context) (authz.Subject, error) {
	subj, ok := subjectFrom(ctx)
	if !ok {
		return authz.Subject{}, os.ErrPermission
	}
	return subj, nil
}

// isWrite mirrors the NFS adapter: any create/write/append/trunc intent routes to
// the Editor-gated Create; a pure read routes to the Viewer-gated Open.
func isWrite(flag int) bool {
	return flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_APPEND|os.O_TRUNC) != 0
}

func (fsys *boundFS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (xwebdav.File, error) {
	subj, err := subject(ctx)
	if err != nil {
		return nil, err
	}
	if isWrite(flag) {
		f, err := fsys.port.Create(ctx, subj, name, flag, perm)
		if err != nil {
			return nil, err
		}
		return &boundFile{port: fsys.port, subj: subj, ctx: ctx, name: name, f: f}, nil
	}
	// Read intent. Stat first (Viewer-gated) so we (a) authorize, and (b) learn
	// whether this is a directory — directories must NOT be opened as byte streams
	// on the backend; their listing comes from StoragePort.List via Readdir.
	fi, err := fsys.port.Stat(ctx, subj, name)
	if err != nil {
		return nil, err
	}
	if fi.IsDir() {
		return &boundFile{port: fsys.port, subj: subj, ctx: ctx, name: name, info: fi}, nil
	}
	f, err := fsys.port.Open(ctx, subj, name)
	if err != nil {
		return nil, err
	}
	return &boundFile{port: fsys.port, subj: subj, ctx: ctx, name: name, f: f, info: fi}, nil
}

func (fsys *boundFS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	subj, err := subject(ctx)
	if err != nil {
		return nil, err
	}
	return fsys.port.Stat(ctx, subj, name)
}

func (fsys *boundFS) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	subj, err := subject(ctx)
	if err != nil {
		return err
	}
	return fsys.port.Mkdir(ctx, subj, name, perm)
}

func (fsys *boundFS) RemoveAll(ctx context.Context, name string) error {
	subj, err := subject(ctx)
	if err != nil {
		return err
	}
	// The StoragePort exposes a single Remove; the backend's Remove is where any
	// recursive semantics live. RemoveAll is authorized here as Editor on the
	// named path exactly like every other mutation.
	return fsys.port.Remove(ctx, subj, name)
}

func (fsys *boundFS) Rename(ctx context.Context, oldName, newName string) error {
	subj, err := subject(ctx)
	if err != nil {
		return err
	}
	return fsys.port.Rename(ctx, subj, oldName, newName)
}

// boundFile adapts a directory or a storage.File to webdav.File. For a directory,
// f is nil and Readdir lists via StoragePort.List; for a regular file, f is the
// authorized byte-stream handle. It carries the Subject and ctx so Readdir
// re-enters the Guard as the same caller.
type boundFile struct {
	port storage.StoragePort
	subj authz.Subject
	ctx  context.Context
	name string
	f    storage.File // nil for directories
	info os.FileInfo  // cached Stat; nil for freshly created files

	// directory paging state for Readdir.
	dirEntries []os.FileInfo
	dirPos     int
	dirRead    bool
}

func (b *boundFile) Read(p []byte) (int, error) {
	if b.f == nil {
		return 0, os.ErrInvalid // is a directory
	}
	return b.f.Read(p)
}

func (b *boundFile) Write(p []byte) (int, error) {
	if b.f == nil {
		return 0, os.ErrInvalid
	}
	return b.f.Write(p)
}

func (b *boundFile) Seek(offset int64, whence int) (int64, error) {
	if b.f == nil {
		return 0, os.ErrInvalid
	}
	return b.f.Seek(offset, whence)
}

func (b *boundFile) Close() error {
	if b.f == nil {
		return nil
	}
	return b.f.Close()
}

// Readdir maps directory iteration to the authorized StoragePort.List, which
// batch-filters children the Subject may not view — so a WebDAV PROPFIND depth-1
// only ever discloses viewable entries, exactly like the NFS ReadDir path. The
// full listing is materialized once (webdav calls Readdir(0) = "all"); paging is
// supported for well-behaved clients that pass a positive count.
func (b *boundFile) Readdir(count int) ([]os.FileInfo, error) {
	if !b.dirRead {
		if b.info != nil && !b.info.IsDir() {
			return nil, os.ErrInvalid // not a directory
		}
		entries, err := b.port.List(b.ctx, b.subj, b.name)
		if err != nil {
			return nil, err
		}
		b.dirEntries = entries
		b.dirRead = true
	}
	if count <= 0 {
		rest := b.dirEntries[b.dirPos:]
		b.dirPos = len(b.dirEntries)
		return rest, nil
	}
	if b.dirPos >= len(b.dirEntries) {
		return nil, io.EOF
	}
	end := b.dirPos + count
	if end > len(b.dirEntries) {
		end = len(b.dirEntries)
	}
	chunk := b.dirEntries[b.dirPos:end]
	b.dirPos = end
	return chunk, nil
}

func (b *boundFile) Stat() (os.FileInfo, error) {
	if b.info != nil {
		return b.info, nil
	}
	// Freshly created file (or a handle opened without a prior Stat): fetch it,
	// authorized as Viewer. Cache so webdav's repeated Stat calls are cheap.
	fi, err := b.port.Stat(b.ctx, b.subj, b.name)
	if err != nil {
		return nil, err
	}
	b.info = fi
	return fi, nil
}

var (
	_ xwebdav.FileSystem = (*boundFS)(nil)
	_ xwebdav.File       = (*boundFile)(nil)
)
