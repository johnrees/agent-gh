declare const AGENT_GH_VERSION: string | undefined;

/** The release tag, set by `--define` in the release build; `dev` for a local build or `bun src/main.ts`. */
export const VERSION: string = typeof AGENT_GH_VERSION === "string" ? AGENT_GH_VERSION : "dev";
