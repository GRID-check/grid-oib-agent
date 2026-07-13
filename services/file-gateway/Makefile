.PHONY: build test vet run down verify

build:
	CGO_ENABLED=0 go build ./...

test:
	go test ./internal/...

vet:
	go vet ./...

# bring up the phase-1 dev stack and seed it
run:
	cd deploy && docker compose up -d s3 workos-mock gateway && docker compose up seed

# build + run the NFS allow/deny + write-path verifier against the running stack
verify:
	cd deploy && docker build -t nfsverify ./client && \
	docker run --rm --network deploy_default -e GATEWAY=gateway:2049 nfsverify

down:
	cd deploy && docker compose down -v
