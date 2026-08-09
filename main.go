package main

import (
	"log"
	"net/http"
	"os"
)

const defaultListenAddr = "127.0.0.1:8080"

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = defaultListenAddr
	}

	if err := http.ListenAndServe(addr, newHandler()); err != nil {
		log.Fatal(err)
	}
}

func newHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}
