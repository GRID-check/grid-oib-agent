// Command gateway is grid-nas-gateway: a file-protocol front (NFSv3 in phase 1)
// for S3-compatible storage that authorizes every file operation, per access,
// against WorkOS FGA. See internal/ for the ports-and-adapters layout.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	nfs "github.com/willscott/go-nfs"

	"gridnas/gateway/internal/audit"
	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/config"
	"gridnas/gateway/internal/identity"
	"gridnas/gateway/internal/observability"
	"gridnas/gateway/internal/policy"
	protonfs "gridnas/gateway/internal/proto/nfs"
	"gridnas/gateway/internal/storage"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(2)
	}
	log.Info("starting grid-file-gateway",
		"env", cfg.Env, "nfs", cfg.ListenNFS, "admin", cfg.ListenAdmin,
		"data", cfg.DataDir, "resolver", cfg.IdentityResolver,
		"policy_mode", cfg.PolicyMode, "shared_cache", cfg.RedisURL != "")

	// --- adapters (edges) ---
	metrics := observability.NewMetrics()
	policyClient, err := buildPolicyClient(cfg, log)
	if err != nil {
		log.Error("build policy client", "err", err)
		os.Exit(1)
	}
	sink := audit.NewSlogSink(log)

	engine, err := authz.New(policyClient, sink, metrics, authz.Config{
		CacheSize:  cfg.CacheSize,
		CacheTTL:   cfg.CacheTTL,
		CacheGrace: cfg.CacheGrace,
	})
	if err != nil {
		log.Error("build authz engine", "err", err)
		os.Exit(1)
	}

	backend := storage.NewBillyFUSEBackend(cfg.DataDir)
	guard := storage.NewGuard(backend, engine)

	resolver, err := buildResolver(cfg)
	if err != nil {
		log.Error("build identity resolver", "err", err)
		os.Exit(1)
	}

	handler := protonfs.NewHandler(guard, resolver, log)

	// --- admin server: liveness, readiness, metrics ---
	var ready atomic.Bool
	admin := &http.Server{Addr: cfg.ListenAdmin, Handler: adminMux(&ready, backend, metrics)}
	go func() {
		if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("admin server", "err", err)
		}
	}()

	// --- NFS server ---
	ln, err := net.Listen("tcp", cfg.ListenNFS)
	if err != nil {
		log.Error("listen nfs", "err", err)
		os.Exit(1)
	}
	log.Info("nfs listening", "addr", ln.Addr().String())
	ready.Store(true)

	serveErr := make(chan error, 1)
	go func() { serveErr <- nfs.Serve(ln, handler) }()

	// --- graceful shutdown ---
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErr:
		log.Error("nfs server exited", "err", err)
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	}
	ready.Store(false)
	_ = ln.Close()
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = admin.Shutdown(shutCtx)
	log.Info("stopped")
}

// buildPolicyClient selects the authorization source and wraps it with the
// shared Dragonfly decision cache (no-op if REDIS_URL is unset).
func buildPolicyClient(cfg config.Config, log *slog.Logger) (policy.Client, error) {
	var inner policy.Client
	switch cfg.PolicyMode {
	case "bff":
		// Delegate to the BFF — the single authz brain (WorkOS FGA + org membership).
		inner = policy.NewBFF(cfg.BFFEndpoint, cfg.InternalToken, cfg.PolicyTimeout)
	case "workos":
		inner = policy.NewWorkOS(cfg.PolicyEndpoint, cfg.PolicyAPIKey, cfg.PolicyTimeout)
	default:
		return nil, errors.New("unsupported policy mode: " + cfg.PolicyMode)
	}
	return policy.NewCaching(inner, cfg.RedisURL, cfg.SharedCacheTTL, log)
}

func buildResolver(cfg config.Config) (identity.Resolver, error) {
	switch cfg.IdentityResolver {
	case "dirpath":
		return identity.NewDirpathResolver(cfg.Env), nil
	// case "mounttoken", "kerberos", "smb": wired in a follow-up (signed mount
	// token → user+org; then NFSv4+Kerberos or SMB session for authenticated identity).
	default:
		return nil, errors.New("unsupported identity resolver: " + cfg.IdentityResolver)
	}
}

func adminMux(ready *atomic.Bool, backend storage.Backend, m *observability.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		// Ready only once the NFS listener is up AND the storage root is reachable.
		if !ready.Load() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		if _, err := backend.Stat("."); err != nil {
			http.Error(w, "storage unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.Handle("/metrics", promhttp.HandlerFor(m.Registry(), promhttp.HandlerOpts{}))
	return mux
}
