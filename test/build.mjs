import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(__dirname, "entry.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: path.join(__dirname, "entry.bundle.cjs"),
  external: [],
  alias: {
    obsidian: path.join(__dirname, "obsidian-mock.ts"),
  },
  logLevel: "warning",
});

console.log("test bundle: test/entry.bundle.cjs");
