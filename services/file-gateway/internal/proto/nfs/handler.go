// Package nfs is the NFSv3 protocol adapter. It binds an authenticated Subject at
// mount time (via an identity.Resolver) and hands go-nfs a per-subject
// billy.Filesystem whose every operation is authorized through the StoragePort.
// This package is the only place that knows about NFS; swapping to SMB/NFSv4
// means a sibling adapter, with the core untouched (ADR-2).
package nfs

import (
	"context"
	"log/slog"
	"net"

	billy "github.com/go-git/go-billy/v5"
	nfs "github.com/willscott/go-nfs"
	nfshelper "github.com/willscott/go-nfs/helpers"

	"gridnas/gateway/internal/identity"
	"gridnas/gateway/internal/storage"
)

// Handler resolves identity per mount and serves an authorized filesystem.
type Handler struct {
	port     storage.StoragePort
	resolver identity.Resolver
	log      *slog.Logger
}

func NewHandler(port storage.StoragePort, resolver identity.Resolver, log *slog.Logger) nfs.Handler {
	h := &Handler{port: port, resolver: resolver, log: log}
	// CachingHandler supplies file-handle <-> (fs, path) mapping; the per-subject
	// fs returned by Mount travels with each handle for the mount's lifetime.
	return nfshelper.NewCachingHandler(h, 4096)
}

func (h *Handler) Mount(ctx context.Context, conn net.Conn, req nfs.MountRequest) (nfs.MountStatus, billy.Filesystem, []nfs.AuthFlavor) {
	pid := identity.ProtocolIdentity{Dirpath: string(req.Dirpath)}
	if conn != nil && conn.RemoteAddr() != nil {
		pid.ClientIP = conn.RemoteAddr().String()
	}
	subj, err := h.resolver.Resolve(ctx, pid)
	if err != nil {
		h.log.Warn("mount denied: unauthenticated", "dirpath", string(req.Dirpath), "err", err)
		return nfs.MountStatusErrAcces, nil, nil
	}
	h.log.Info("mount", "subject", subj.ID, "dirpath", string(req.Dirpath), "resolver", h.resolver.Name())
	return nfs.MountStatusOk, newBoundFS(h.port, subj), []nfs.AuthFlavor{nfs.AuthFlavorNull}
}

func (h *Handler) Change(fs billy.Filesystem) billy.Change {
	if c, ok := fs.(billy.Change); ok {
		return c
	}
	return nil
}

func (h *Handler) FSStat(context.Context, billy.Filesystem, *nfs.FSStat) error { return nil }

// Handle plumbing is provided by the wrapping CachingHandler.
func (h *Handler) ToHandle(billy.Filesystem, []string) []byte { return nil }
func (h *Handler) FromHandle([]byte) (billy.Filesystem, []string, error) {
	return nil, nil, nil
}
func (h *Handler) InvalidateHandle(billy.Filesystem, []byte) error { return nil }
func (h *Handler) HandleLimit() int                                { return -1 }
