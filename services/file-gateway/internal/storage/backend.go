package storage

import (
	"os"
	"time"
)

// Backend is the RAW, UNAUTHORIZED storage. It has no notion of a Subject and
// performs no policy checks -- it is never handed to a protocol adapter directly;
// only the Guard wraps it. Implementations: billyBackend (rclone/FUSE, phase 1)
// and, later, a native aws-sdk-go-v2 S3 backend (ADR-1) behind this same
// interface -- a swap, not a rewrite.
type Backend interface {
	OpenFile(path string, flag int, perm os.FileMode) (File, error)
	Stat(path string) (os.FileInfo, error)
	Lstat(path string) (os.FileInfo, error)
	ReadDir(path string) ([]os.FileInfo, error)
	Remove(path string) error
	Rename(oldPath, newPath string) error
	MkdirAll(path string, perm os.FileMode) error
	Symlink(target, link string) error
	Readlink(path string) (string, error)
	Chmod(path string, mode os.FileMode) error
	Chown(path string, uid, gid int) error
	Lchown(path string, uid, gid int) error
	Chtimes(path string, atime, mtime time.Time) error
	Root() string
}
