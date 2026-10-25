import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "src/App.jsx")],
  bundle: true,
  minify: true,
  outfile: join(here, "../web/app.js"),
  jsx: "automatic",
  target: "es2022",
  format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
});
