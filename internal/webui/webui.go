package webui

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

//go:embed dist
var assets embed.FS

type handler struct {
	files http.Handler
	fsys  fs.FS
}

func Handler() http.Handler {
	sub, _ := fs.Sub(assets, "dist")
	return &handler{files: http.FileServer(http.FS(sub)), fsys: sub}
}
func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if clean == "." {
		clean = "index.html"
	}
	if strings.HasPrefix(clean, "assets/") {
		if ext := path.Ext(clean); ext != "" {
			w.Header().Set("Content-Type", mime.TypeByExtension(ext))
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.files.ServeHTTP(w, r)
		return
	}
	if _, err := fs.Stat(h.fsys, clean); err == nil {
		h.files.ServeHTTP(w, r)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	w.Header().Set("Cache-Control", "no-cache")
	h.files.ServeHTTP(w, r2)
}
