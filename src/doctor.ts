import { runChild } from "./child.ts";
import { botEmail } from "./env.ts";
import { type Context, withToken } from "./run.ts";
import { slug } from "./repo.ts";

/**
 * One check of the whole path: who is acting (harness, model, family, bot),
 * then the bot's login through gh, its git author, and git access to the
 * repository, all with one token. Exit 0 only if all hold.
 */
export const doctor = async (context: Context, print: (line: string) => void): Promise<number> => {
  const { identity } = context;
  print(`harness: ${identity.harness}`);
  print(`model: ${identity.model ?? "not reported"}`);
  if (identity.effort !== undefined) print(`effort: ${identity.effort}`);
  print(`family: ${identity.family}`);
  print(`repository: ${slug(context.repo)}`);
  return withToken(context, async (env, config) => {
    print(`bot: ${config.bot_login}`);
    const login = await runChild(
      ["gh", "api", "graphql", "-f", "query={ viewer { login } }", "--jq", ".data.viewer.login"],
      env,
      true,
    );
    const ident = await runChild(["git", "var", "GIT_AUTHOR_IDENT"], env, true);
    const remote = await runChild(
      ["git", "ls-remote", `https://github.com/${slug(context.repo)}.git`, "HEAD"],
      env,
      true,
    );
    const checks = [
      ["gh login", login.code === 0 && login.stdout.trim() === config.bot_login, login.stdout.trim() || "none"],
      [
        "git author",
        ident.code === 0 && ident.stdout.startsWith(`${config.bot_login} <${botEmail(config)}>`),
        ident.stdout.trim().replace(/ \d+ [+-]\d{4}$/, "") || "none",
      ],
      ["repository access", remote.code === 0, remote.code === 0 ? "git ls-remote succeeded" : "git ls-remote failed"],
    ] as const;
    for (const [name, ok, seen] of checks) print(`${ok ? "ok  " : "FAIL"} ${name}: ${seen}`);
    return checks.every(([, ok]) => ok) ? 0 : 1;
  });
};
