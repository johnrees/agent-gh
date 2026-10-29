/**
 * bun scripts/timeline.ts [file]: reads `agent-gh graph --json` from a file,
 * or from stdin, and prints the timeline page, with src/timeline-page.ts
 * bundled into it.
 */
import { join } from "node:path";
import type { GraphJson } from "../src/graph.ts";
import { timelineHtml } from "../src/timeline.ts";

const [file, ...rest] = process.argv.slice(2);
if (rest.length > 0 || file?.startsWith("-")) {
  console.error("usage: bun scripts/timeline.ts [file] > timeline.html");
  process.exit(2);
}
const json = JSON.parse(file === undefined ? await Bun.stdin.text() : await Bun.file(file).text()) as GraphJson;
if (json?.v !== 1 || !Array.isArray(json.issues)) {
  console.error("timeline: not agent-gh graph --json output (v 1)");
  process.exit(1);
}
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "timeline-page.ts")], target: "browser", minify: true });
const [bundle] = built.outputs;
if (!built.success || bundle === undefined) {
  console.error(`timeline: the page's script did not build\n${built.logs.join("\n")}`);
  process.exit(1);
}
process.stdout.write(timelineHtml(json, await bundle.text()));
