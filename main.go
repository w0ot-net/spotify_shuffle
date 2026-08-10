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
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://accounts.spotify.com https://api.spotify.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

//go:embed web/index.html
var indexHTML []byte

//go:embed web/pure.js
var pureJS []byte

//go:embed web/app.js
var appJS []byte

//go:embed web/styles.css
var stylesCSS []byte

//go:embed web/background-weave.jpg
var backgroundWeaveJPEG []byte

//go:embed web/background-veil.jpg
var backgroundVeilJPEG []byte

//go:embed web/background-orbit.jpg
var backgroundOrbitJPEG []byte

//go:embed web/background-tide.jpg
var backgroundTideJPEG []byte

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = defaultListenAddr
	}

	store, err := openTelemetryStore(os.Getenv("TELEMETRY_DB_PATH"))
	if err != nil {
		log.Fatal(err)
	}

	handler, err := newHandler(os.Getenv("SPOTIFY_CLIENT_ID"), store)
	if err != nil {
		log.Fatal(err)
	}

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}

func newHandler(spotifyClientID string, telemetry *telemetryStore) (http.Handler, error) {
	spotifyClientID = strings.TrimSpace(spotifyClientID)
	if spotifyClientID == "" {
		return nil, errors.New("SPOTIFY_CLIENT_ID is required")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/telemetry", newTelemetryIntake(telemetry, spotifyClientID).handle)
	serveApp := func(w http.ResponseWriter, _ *http.Request) {
		setBrowserSecurityHeaders(w)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(indexHTML)
	}
	serveAsset := func(content []byte, contentType string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			setBrowserSecurityHeaders(w)
			w.Header().Set("Content-Type", contentType)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(content)
		}
	}
	mux.HandleFunc("GET /{$}", serveApp)
	mux.HandleFunc("GET /callback", serveApp)
	mux.HandleFunc("GET /pure.js", serveAsset(pureJS, "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /app.js", serveAsset(appJS, "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /styles.css", serveAsset(stylesCSS, "text/css; charset=utf-8"))
	mux.HandleFunc("GET /background-weave.jpg", serveAsset(backgroundWeaveJPEG, "image/jpeg"))
	mux.HandleFunc("GET /background-veil.jpg", serveAsset(backgroundVeilJPEG, "image/jpeg"))
	mux.HandleFunc("GET /background-orbit.jpg", serveAsset(backgroundOrbitJPEG, "image/jpeg"))
	mux.HandleFunc("GET /background-tide.jpg", serveAsset(backgroundTideJPEG, "image/jpeg"))
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
