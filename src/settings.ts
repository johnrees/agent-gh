import { isConfigured, readConfig, REGISTRY, type Registry } from "./config.ts";
import { familyNames } from "./family.ts";

/** Families with an App: recorded locally by `agent-gh setup`, or committed in apps.json. */
export const configuredFamilies = (dir: string, registry: Registry = REGISTRY): string[] =>
  familyNames().filter((family) => isConfigured(dir, family, registry));

/**
 * The pages where a family App is changed by hand: GitHub has no API to edit an
 * App's permissions or the repositories an installation may use. The slug comes
 * from the App's config, since GitHub may have assigned a different one.
 */
export const settingsLines = (dir: string, family: string, github: string, registry: Registry = REGISTRY): string[] => {
  if (!isConfigured(dir, family, registry)) {
    return [
      `${family}: has no App yet; run \`agent-gh setup ${family}\` on the machine where you create Apps, then commit the registry entry it prints`,
    ];
  }
  const { slug } = readConfig(dir, family, registry);
  return [
    `${family}: ${slug}`,
    `  app settings:      ${github}/settings/apps/${slug}`,
    `  permissions:       ${github}/settings/apps/${slug}/permissions`,
    `  repository access: ${github}/apps/${slug}/installations/new`,
  ];
};
