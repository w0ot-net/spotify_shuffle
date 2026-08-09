package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
)

const defaultListenAddr = "127.0.0.1:8080"
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; connect-src 'self' https://accounts.spotify.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

//go:embed web/index.html
var indexHTML []byte

//go:embed web/app.js
var appJS []byte

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = defaultListenAddr
	}

	handler, err := newHandler(os.Getenv("SPOTIFY_CLIENT_ID"))
	if err != nil {
		log.Fatal(err)
	}

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}

func newHandler(spotifyClientID string) (http.Handler, error) {
	spotifyClientID = strings.TrimSpace(spotifyClientID)
	if spotifyClientID == "" {
		return nil, errors.New("SPOTIFY_CLIENT_ID is required")
	}

	mux := http.NewServeMux()
	serveApp := func(w http.ResponseWriter, _ *http.Request) {
		setBrowserSecurityHeaders(w)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(indexHTML)
	}
	mux.HandleFunc("GET /{$}", serveApp)
	mux.HandleFunc("GET /callback", serveApp)
	mux.HandleFunc("GET /app.js", func(w http.ResponseWriter, _ *http.Request) {
		setBrowserSecurityHeaders(w)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(appJS)
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		setBrowserSecurityHeaders(w)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(struct {
			SpotifyClientID string `json:"spotify_client_id"`
		}{SpotifyClientID: spotifyClientID})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux, nil
}

func setBrowserSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
