package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"strconv"

	"github.com/babel-o/go-runner/internal/runner"
)

func main() {
	host := getenv("GO_RUNNER_HOST", "127.0.0.1")
	if !isLocalBindHost(host) && getenv("GO_RUNNER_ALLOW_NON_LOCAL_BIND", "0") != "1" {
		log.Fatalf("refusing non-local GO_RUNNER_HOST=%q without GO_RUNNER_ALLOW_NON_LOCAL_BIND=1", host)
	}
	port := getenv("GO_RUNNER_PORT", "3897")
	id := getenv("GO_RUNNER_ID", "go-remote-runner")
	address := net.JoinHostPort(host, port)

	server := runner.NewServerWithOptions(runner.ServerOptions{
		ID:                 id,
		EnableBash:         getenv("GO_RUNNER_ENABLE_BASH", "0") == "1",
		EnableWrite:        getenv("GO_RUNNER_ENABLE_WRITE", "0") == "1",
		MaxConcurrentTools: getenvInt("GO_RUNNER_MAX_CONCURRENT_TOOLS", 0),
		MaxOutputBytes:     getenvInt64("GO_RUNNER_MAX_OUTPUT_BYTES", 0),
		BashMaxBufferBytes: getenvInt64("GO_RUNNER_BASH_MAX_BUFFER_BYTES", 0),
		DefaultDeadlineMs:  getenvInt64("GO_RUNNER_DEFAULT_DEADLINE_MS", 0),
		MaxDeadlineMs:      getenvInt64("GO_RUNNER_MAX_DEADLINE_MS", 0),
	})
	log.Printf("BabeL-O Go Runner listening on %s", address)
	if err := http.ListenAndServe(address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}

func getenv(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}

func getenvInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		log.Fatalf("invalid %s=%q", name, value)
	}
	return parsed
}

func getenvInt64(name string, fallback int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		log.Fatalf("invalid %s=%q", name, value)
	}
	return parsed
}

func isLocalBindHost(host string) bool {
	parsed := net.ParseIP(host)
	if parsed == nil {
		return host == "localhost"
	}
	return parsed.IsLoopback()
}
