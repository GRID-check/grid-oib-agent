.PHONY: build test vet verify

build:
	CGO_ENABLED=0 go build ./...

test:
	go test ./internal/...

vet:
	go vet ./...

verify: vet build test

# Dev stack: the gateway runs as part of the main compose file —
#   docker compose -f deploy/compose/docker-compose.yaml up file-gateway
# (repo root). It mounts the shared object store via rclone and authorizes
# against the frontend BFF; see deploy/ for the image and docs/ for details.
