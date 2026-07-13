# Build context is the repository root (see docker-compose.yml).
# --- build the gateway binary ---
FROM golang:1.23 AS build
WORKDIR /src
# Building behind a TLS-intercepting proxy? Add your CA and
# `ENV SSL_CERT_FILE=/ca.crt` here; standard build envs need nothing.
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -o /out/gateway ./cmd/gateway

# --- runtime: rclone image already has rclone + fuse + busybox ---
FROM rclone/rclone:latest
USER root
COPY --from=build /out/gateway /usr/local/bin/gateway
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
