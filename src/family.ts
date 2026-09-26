/**
 * Model families. A bot is `johnrees-<family>`: one GitHub App per family of
 * models, whichever harness drives the model. Add a family only when its model
 * ids, providers, and API hosts can be told apart from every other family.
 */
type Family = {
  readonly name: string;
  /** Model ids, after any `vendor/` prefix, start with one of these. */
  readonly models: RegExp;
  /** The `vendor/` prefix aggregators (OpenRouter, opencode Zen) put on the id. */
  readonly vendors: readonly string[];
  /** Harness provider ids that serve only this family (pi's, opencode's). */
  readonly providers: readonly string[];
  /** API hosts that serve only this family, for Claude Code's ANTHROPIC_BASE_URL. */
  readonly hosts: readonly string[];
};

export const FAMILIES: readonly Family[] = [
  {
    name: "claude",
    models: /^claude-/,
    vendors: ["anthropic"],
    providers: ["anthropic"],
    hosts: ["api.anthropic.com"],
  },
  {
    // "codex" names the OpenAI family so the App made for Codex stays valid.
    name: "codex",
    models: /^(gpt-|o[134](-|$)|codex-|chatgpt-)/,
    vendors: ["openai"],
    providers: ["openai", "openai-codex"],
    hosts: ["api.openai.com", "chatgpt.com"],
  },
  {
    name: "glm",
    models: /^glm-/,
    vendors: ["z-ai", "zai", "zhipuai", "thudm"],
    providers: ["zai", "zai-coding-plan", "zhipuai", "zhipuai-coding-plan"],
    hosts: ["api.z.ai", "open.bigmodel.cn"],
  },
  {
    name: "deepseek",
    models: /^deepseek-/,
    vendors: ["deepseek"],
    providers: ["deepseek"],
    hosts: ["api.deepseek.com"],
  },
  {
    name: "kimi",
    models: /^(kimi-|moonshot-)/,
    vendors: ["moonshotai", "moonshot"],
    providers: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot"],
    hosts: ["api.moonshot.ai", "api.moonshot.cn", "api.kimi.com"],
  },
  {
    name: "qwen",
    models: /^qwen/,
    vendors: ["qwen", "alibaba"],
    providers: ["alibaba", "dashscope", "qwen"],
    hosts: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
  },
];

export const familyNames = (): string[] => FAMILIES.map((family) => family.name);

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * The family a model id belongs to. Accepts a bare id (`glm-4.6`), a
 * `vendor/id` (`z-ai/glm-4.6`), or a `provider/id` (`zai/glm-4.6`). A vendor
 * and an id that disagree give undefined, never a pick of one.
 */
export const familyOfModel = (model: string): string | undefined => {
  const parts = lower(model).split("/");
  const id = parts.at(-1) ?? "";
  const byId = FAMILIES.find((family) => family.models.test(id))?.name;
  const prefix = parts.length > 1 ? parts.at(-2) : undefined;
  const byPrefix =
    prefix === undefined
      ? undefined
      : FAMILIES.find((family) => family.vendors.includes(prefix) || family.providers.includes(prefix))?.name;
  if (byId !== undefined && byPrefix !== undefined && byId !== byPrefix) return undefined;
  return byId ?? byPrefix;
};

/** The family a provider id serves only, or undefined for aggregators and unknowns. */
export const familyOfProvider = (provider: string): string | undefined =>
  FAMILIES.find((family) => family.providers.includes(lower(provider)))?.name;

/** The family an API host serves only, or undefined for gateways and unknowns. */
export const familyOfHost = (host: string): string | undefined =>
  FAMILIES.find((family) => family.hosts.includes(lower(host)))?.name;
