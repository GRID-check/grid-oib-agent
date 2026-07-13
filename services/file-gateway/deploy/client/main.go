// nfsverify: a dumb NFSv3 client proving grid-nas-gateway's server-side authz,
// including the WRITE path that was unguarded in the PoC. Identity = export path.
package main

import (
	"fmt"
	"io"
	"os"

	nfsc "github.com/willscott/go-nfs-client/nfs"
	rpc "github.com/willscott/go-nfs-client/nfs/rpc"
)

func mount(host, subject string) (*nfsc.Target, func(), error) {
	c, err := rpc.DialTCP("tcp", host, false)
	if err != nil {
		return nil, func() {}, err
	}
	var m nfsc.Mount
	m.Client = c
	target, err := m.Mount("/"+subject, rpc.AuthNull)
	if err != nil {
		c.Close()
		return nil, func() {}, fmt.Errorf("mount /%s: %w", subject, err)
	}
	return target, func() { _ = m.Unmount(); c.Close() }, nil
}

func do(host, subject string, fn func(t *nfsc.Target) error) error {
	t, cleanup, err := mount(host, subject)
	if err != nil {
		return err
	}
	defer cleanup()
	return fn(t)
}

// outcome runs an op and reports ALLOW (nil err) or DENY (any err).
func outcome(err error) string {
	if err == nil {
		return "ALLOW"
	}
	return "DENY"
}

type row struct {
	subject, op, path, want string
	run                     func(t *nfsc.Target) error
}

func main() {
	host := os.Getenv("GATEWAY")
	if host == "" {
		host = "gateway:2049"
	}

	rows := []row{
		// --- READS (Viewer) ---
		{"alice", "READ ", "/org-acme/project-atlas/plan.pdf", "ALLOW", func(t *nfsc.Target) error {
			f, err := t.Open("/org-acme/project-atlas/plan.pdf")
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.ReadAll(f)
			return err
		}},
		{"bob", "READ ", "/org-acme/project-atlas/plan.pdf", "DENY", func(t *nfsc.Target) error {
			f, err := t.Open("/org-acme/project-atlas/plan.pdf")
			if err != nil {
				return err
			}
			f.Close()
			return nil
		}},
		{"bob", "READ ", "/org-acme/project-zenith/design.pdf", "ALLOW", func(t *nfsc.Target) error {
			f, err := t.Open("/org-acme/project-zenith/design.pdf")
			if err != nil {
				return err
			}
			f.Close()
			return nil
		}},

		// --- WRITES (Editor) — the path that was UNGUARDED in the PoC ---
		// bob can READ zenith but must NOT be able to mutate it (viewer != editor).
		{"bob", "CREATE", "/org-acme/project-zenith/hack.txt", "DENY", func(t *nfsc.Target) error {
			_, err := t.Create("/org-acme/project-zenith/hack.txt", 0644)
			return err
		}},
		{"bob", "REMOVE", "/org-acme/project-zenith/design.pdf", "DENY", func(t *nfsc.Target) error {
			return t.Remove("/org-acme/project-zenith/design.pdf")
		}},
		{"bob", "RENAME", "/org-acme/project-zenith/design.pdf", "DENY", func(t *nfsc.Target) error {
			return t.Rename("/org-acme/project-zenith/design.pdf", "/org-acme/project-zenith/stolen.pdf")
		}},
		// alice IS editor on atlas -> writes allowed.
		{"alice", "CREATE", "/org-acme/project-atlas/notes.txt", "ALLOW", func(t *nfsc.Target) error {
			_, err := t.Create("/org-acme/project-atlas/notes.txt", 0644)
			return err
		}},
		{"alice", "REMOVE", "/org-acme/project-atlas/notes.txt", "ALLOW", func(t *nfsc.Target) error {
			return t.Remove("/org-acme/project-atlas/notes.txt")
		}},
		// oib-core is read-only ground truth: even a member cannot write.
		{"alice", "CREATE", "/oib-core/tamper.txt", "DENY", func(t *nfsc.Target) error {
			_, err := t.Create("/oib-core/tamper.txt", 0644)
			return err
		}},
	}

	fmt.Printf("%-6s %-6s %-40s %-6s %-6s %s\n", "SUBJ", "OP", "PATH", "GOT", "WANT", "RESULT")
	failures := 0
	for _, r := range rows {
		got := outcome(do(host, r.subject, r.run))
		mark := "ok"
		if got != r.want {
			mark = "MISMATCH!"
			failures++
		}
		fmt.Printf("%-6s %-6s %-40s %-6s %-6s %s\n", r.subject, r.op, r.path, got, r.want, mark)
	}
	if failures > 0 {
		fmt.Printf("\nRESULT: %d MISMATCH(es)\n", failures)
		os.Exit(1)
	}
	fmt.Println("\nRESULT: reads and writes independently gated — all decisions matched")
}
