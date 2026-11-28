// Package webui embeds the committed dashboard files. It
// lives at the repo root because //go:embed patterns cannot
// reach ../web from a cmd directory.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed web/index.html web/app.js web/style.css
var embedded embed.FS

// Files returns the dashboard files at its root.
func Files() fs.FS {
	sub, err := fs.Sub(embedded, "web")
	if err != nil {
		panic(err)
	}
	return sub
}
