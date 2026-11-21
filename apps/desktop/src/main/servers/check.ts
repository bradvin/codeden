import { HealthResponse } from "@codeden/contracts";

export type ServerCheck =
  | { ok: true; version: string; warning: string | null }
  | { ok: false; problem: string };

export interface CheckOptions {
  /** Chromium's network stack (`net.fetch`): the system's certificate store, never a bypass. */
  fetch: typeof fetch;
  /** This app's version, for the version warning. */
  version: string;
  timeoutMs?: number;
}

/**
 * Ask a server whether it is CodeDen before it is saved: `GET /api/health`, which is public, so
 * nothing is sent with the request (no token, no cookie). A certificate Chromium doesn't trust
 * fails like any other network error; there is no way to accept it. A different version of
 * CodeDen is a warning, not an error.
 */
export async function checkServer(origin: string, opts: CheckOptions): Promise<ServerCheck> {
  let res: Response;
  try {
    res = await opts.fetch(`${origin}/api/health`, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
  } catch (error) {
    return { ok: false, problem: networkProblem(error) };
  }
  if (!res.ok) {
    return {
      ok: false,
      problem: `The server answered ${res.status}. Is this address listed under Trusted origins in that CodeDen's Network access settings?`,
    };
  }
  const body = HealthResponse.safeParse(await res.json().catch(() => null));
  if (!body.success)
    return { ok: false, problem: "That address does not look like a CodeDen server." };
  const { version } = body.data;
  return {
    ok: true,
    version,
    warning:
      version === opts.version
        ? null
        : `That server runs CodeDen ${version}; this app is ${opts.version}. It may not work as expected until both are updated.`,
  };
}

function networkProblem(error: unknown): string {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  if (/CERT|SSL|TLS/i.test(text)) {
    return "The certificate is not trusted. CodeDen only connects to servers with a valid certificate.";
  }
  if (/TIMEOUT|abort/i.test(text)) return "The server did not answer in time.";
  return "Could not reach that address. Check that this device is signed in to your tailnet and the address is right.";
}
