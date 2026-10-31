import { Failure } from "./failure.ts";
import { request } from "./github.ts";
import { slug } from "./repo.ts";
import { waiveMarker } from "./review.ts";
import { pull, pullNumber, pullWorkers, readReviewConfig, type ReviewIo, waiver } from "./review-run.ts";

export type WaiveOptions = { readonly pr?: number; readonly reason: string };

const STAGE = "waiving the review" as const;

/**
 * `agent-gh waive`: a delegated review waiver, posted through the App of
 * `io.family`, the orchestrator's:
 * a comment starting `Waived:` with the reason and a marker naming the head
 * and this session, then the waiver label. It refuses where the base
 * branch's config does not list the identity in `waiver_by`, and on a pull
 * request this identity or this session worked on; the gate and the workflow
 * check the same again (`delegatedWaiver`), so the refusal here only says why
 * early.
 */
export const waiveCommand = async (io: ReviewIo, options: WaiveOptions): Promise<void> => {
  const reason = options.reason.trim();
  if (reason === "") throw new Failure(STAGE, "--reason needs the evidence: who reviewed it independently, and which tests ran at the head");
  if (io.session === undefined) throw new Failure(STAGE, "this session has no id in its environment, so its waiver could not be told from the worker's; set AGENT_GH_SESSION");
  const number = options.pr ?? (await pullNumber(io, STAGE, { branch: undefined }));
  if (number === undefined) throw new Failure(STAGE, "cannot find this branch's pull request; name it with --pr N");
  const pr = await pull(io, STAGE, number);
  const config = await readReviewConfig(io, STAGE, pr.base);
  if (config === undefined) throw new Failure(STAGE, `${slug(io.repo)} has no .github/agent-review.json on ${pr.base}, so there is no review to waive`);
  if (!config.waiverBy.includes(io.family)) {
    throw new Failure(STAGE, `.github/agent-review.json on ${pr.base} does not list ${io.family} in waiver_by, so its waiver would count for nothing; only John's own \`${config.waiverLabel}\` label waives here`);
  }
  const workers = await pullWorkers(io, STAGE, pr);
  if (workers === undefined) throw new Failure(STAGE, `pull request #${number} has 250 commits or more, so who worked on it cannot be read; John waives it himself`);
  if (workers.identities.includes(io.family)) throw new Failure(STAGE, `${io.family} worked on pull request #${number} (it opened it, holds its claim, or co-authored a commit), and a worker never waives its own review`);
  if (workers.sessions.includes(io.session)) throw new Failure(STAGE, `this session (${io.session}) worked on pull request #${number} (its claim or a commit's Agent-Session), and a worker never waives its own review`);
  const body = `Waived: ${reason}\n\nHead: ${pr.head}\n\n${waiveMarker({ v: 1, head: pr.head, session: io.session })}`;
  const post = async (path: string, value: unknown) => {
    const { status } = await request(io.api, STAGE, "POST", `/repos/${slug(io.repo)}${path}`, io.token, value);
    if (status < 200 || status >= 300) throw new Failure(STAGE, `HTTP ${status} from POST ${path}`);
  };
  await post(`/issues/${number}/comments`, { body });
  // Adding a label already on records no event, so the label would stay whoever added it: take it off first.
  if (pr.labels.includes(config.waiverLabel)) {
    const path = `/repos/${slug(io.repo)}/issues/${number}/labels/${encodeURIComponent(config.waiverLabel)}`;
    const { status } = await request(io.api, STAGE, "DELETE", path, io.token);
    if (status !== 200 && status !== 404) throw new Failure(STAGE, `HTTP ${status} from DELETE the ${config.waiverLabel} label`);
  }
  await post(`/issues/${number}/labels`, { labels: [config.waiverLabel] });
  // Read back as the gate reads it, so a waiver that does not count is never reported as done.
  const now = await pull(io, STAGE, number);
  const by = await waiver(io, STAGE, now, config);
  if (by === undefined || !by.startsWith(`${io.family} at `)) {
    throw new Failure(STAGE, `the waiver on #${number} does not count as ${io.family}'s (${now.head === pr.head ? `the label reads ${by === undefined ? "as no waiver" : `as ${by}'s`}` : `the head moved to ${now.head.slice(0, 8)} meanwhile`}); run \`agent-gh waive\` again`);
  }
  io.print(
    `agent-gh: waived the review of #${number} at ${pr.head.slice(0, 8)} as ${io.family}; ${config.statusWriter === "actions" ? "the agent-review workflow records it" : "`agent-gh review full` records it on the status"}, and a push voids it`,
  );
};
