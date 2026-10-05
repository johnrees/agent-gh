import { runChild } from "./child.ts";
import { coAuthorTrailer } from "./git.ts";
import { type Repo, slug } from "./repo.ts";
import { type Context, withToken } from "./run.ts";

/**
 * One check of the whole path: who is acting (harness, model, family, App),
 * then, with John's user token for that App: the acting user, that the token
 * belongs to the App (GitHub lists only the issuing App's installations for a
 * user token), John's git author, and git access to the repository. Exit 0
 * only if all hold.
 */
export const doctor = async (context: Context & { readonly repo: Repo }, print: (line: string) => void): Promise<number> => {
  const { identity } = context;
  print(`harness: ${identity.harness}`);
  print(`model: ${identity.model ?? "not reported"}`);
  if (identity.effort !== undefined) print(`effort: ${identity.effort}`);
  print(`family: ${identity.family}`);
  print(`repository: ${slug(context.repo)}`);
  return withToken(context, async (env, config) => {
    print(`app: ${config.slug}`);
    print(`commits get: ${coAuthorTrailer(config)}`);
    const user = await runChild(["gh", "api", "user", "--jq", ".login"], env, true);
    const installs = await runChild(
      ["gh", "api", "user/installations", "--jq", ".installations[] | select(.app_slug == \"" + config.slug + "\") | .account.login"],
      env,
      true,
    );
    const ident = await runChild(["git", "var", "GIT_AUTHOR_IDENT"], env, true);
    const remote = await runChild(["git", "ls-remote", `https://github.com/${slug(context.repo)}.git`, "HEAD"], env, true);
    const login = user.stdout.trim();
    const owners = installs.stdout.trim().split("\n").filter(Boolean);
    const author = ident.stdout.trim().replace(/ \d+ [+-]\d{4}$/, "");
    const checks = [
      ["acting user", user.code === 0 && login !== "" && !login.endsWith("[bot]"), login || "none"],
      [
        "token app",
        installs.code === 0 && owners.includes(context.repo.owner),
        owners.length > 0 ? `${config.slug}, installed on ${owners.join(", ")}` : "no installation of this App for the token",
      ],
      ["git author", ident.code === 0 && author !== "" && !author.includes("[bot]"), author || "none"],
      ["repository access", remote.code === 0, remote.code === 0 ? "git ls-remote succeeded" : "git ls-remote failed"],
    ] as const;
    for (const [name, ok, seen] of checks) print(`${ok ? "ok  " : "FAIL"} ${name}: ${seen}`);
    return checks.every(([, ok]) => ok) ? 0 : 1;
  });
};
