import { Failure } from "./failure.ts";

export type ChildResult = { readonly code: number; readonly stdout: string };

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const signalNumber: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/**
 * Runs a child with the given environment. While it runs, this process
 * ignores the signals the child also receives, so the caller's `finally`
 * (token revocation) still runs; SIGTERM and SIGHUP are forwarded.
 */
export const runChild = async (
  command: readonly string[],
  env: Record<string, string>,
  capture = false,
): Promise<ChildResult> => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...command], {
      env,
      stdin: capture ? "ignore" : "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: "inherit",
    });
  } catch {
    throw new Failure("starting the child", `${command[0]} could not be started`);
  }
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      if (signal !== "SIGINT") child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    const stdout =
      capture && child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve("");
    const [code, text] = await Promise.all([child.exited, stdout]);
    return { code: child.signalCode === null ? code : 128 + (signalNumber[child.signalCode] ?? 0), stdout: text };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
};
