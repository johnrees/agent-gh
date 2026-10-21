/**
 * bun scripts/timeline.ts [file]: reads `agent-gh graph --json` from a file,
 * or from stdin, and prints the timeline page (src/timeline.ts).
 */
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
process.stdout.write(timelineHtml(json));
