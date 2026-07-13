package storage

import "path"

// joinPath joins a directory and child name into a clean slash path used for
// object-id derivation.
func joinPath(dir, name string) string {
	return path.Join(dir, name)
}
