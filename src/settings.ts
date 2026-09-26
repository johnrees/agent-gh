import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { familyNames } from "./family.ts";

/** Families whose App `agent-gh setup` has recorded in `dir`. */
export const configuredFamilies = (dir: string): string[] =>
  familyNames().filter((family) => existsSync(join(dir, `${family}.json`)));

/**
 * The pages where a family App is changed by hand: GitHub has no API to edit an
 * App's permissions or the repositories an installation may use. The slug comes
 * from the recorded config, since GitHub may have assigned a different one.
 */
export const settingsLines = (dir: string, family: string, github: string): string[] => {
  if (!existsSync(join(dir, `${family}.json`))) {
    return [`${family}: not set up; run \`agent-gh setup ${family}\` in your own terminal`];
  }
  const { slug } = readConfig(dir, family);
  return [
    `${family}: ${slug}`,
    `  app settings:      ${github}/settings/apps/${slug}`,
    `  permissions:       ${github}/settings/apps/${slug}/permissions`,
    `  repository access: ${github}/apps/${slug}/installations/new`,
  ];
};
