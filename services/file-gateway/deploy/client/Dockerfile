FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download || true
COPY *.go ./
RUN go mod tidy
RUN CGO_ENABLED=0 go build -o /out/nfsverify .

FROM alpine:latest
COPY --from=build /out/nfsverify /usr/local/bin/nfsverify
ENTRYPOINT ["/usr/local/bin/nfsverify"]
