package policy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestFileAccessContract pins the Go wire structs to the checked-in contract
// (testdata/file-access-contract.json), which mirrors the BFF Zod schema. If a
// field is renamed on either side, or relationToPermission emits a value outside
// the permission enum, this fails — catching the drift class the reviewers flagged.
func TestFileAccessContract(t *testing.T) {
	var contract struct {
		Request struct {
			Keys        []string `json:"keys"`
			Permissions []string `json:"permissions"`
		} `json:"request"`
		Response struct {
			Keys []string `json:"keys"`
		} `json:"response"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "file-access-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}

	assertKeys := func(name string, v any, want []string) {
		b, _ := json.Marshal(v)
		var m map[string]json.RawMessage
		_ = json.Unmarshal(b, &m)
		got := make([]string, 0, len(m))
		for k := range m {
			got = append(got, k)
		}
		sort.Strings(got)
		sort.Strings(want)
		if len(got) != len(want) {
			t.Fatalf("%s keys = %v, want %v", name, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("%s keys = %v, want %v", name, got, want)
			}
		}
	}

	assertKeys("request", bffReq{}, contract.Request.Keys)
	assertKeys("response", bffResp{}, contract.Response.Keys)

	// Every permission the client can emit must be in the contract's enum.
	allowed := map[string]bool{}
	for _, p := range contract.Request.Permissions {
		allowed[p] = true
	}
	for _, rel := range []string{"viewer", "editor"} {
		if p := relationToPermission(rel); !allowed[p] {
			t.Fatalf("relationToPermission(%q)=%q not in contract permissions %v", rel, p, contract.Request.Permissions)
		}
	}
}
