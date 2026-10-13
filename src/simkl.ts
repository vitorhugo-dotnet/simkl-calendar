import { record, positiveId } from "./domain";
import type {
  DispatchRequest,
  DispatchResult,
  TokenGrant,
  Category,
  Activities,
} from "./domain";
import { apiCategory, validDate } from "./calendar";
export class UpstreamError extends Error {
  constructor(
    public status: number,
    public kind: "auth" | "quota" | "burst" | "transient" | "invalid",
    public retryAt: number,
  ) {
    super("Upstream request failed");
  }
}
export function classifyFailure(r: DispatchResult, now: number): UpstreamError {
  const code = record(
    typeof r.body === "string" ? JSON.parse(r.body) : r.body,
  ).error;
  const daily =
    r.status === 429 &&
    ["user_limit_exceeded", "app_limit_exceeded"].includes(String(code));
  let seconds = Number(r.headers["retry-after"]);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = 3600;
  return new UpstreamError(
    r.status,
    r.status === 401
      ? "auth"
      : daily
        ? "quota"
        : r.status === 429
          ? "burst"
          : r.status >= 500
            ? "transient"
            : "invalid",
    now +
      (daily
        ? Math.min(seconds, 86400) * 1000
        : r.status === 429
          ? 1000
          : 60000),
  );
}
export function identifiedUrl(
  url: string,
  config: { SIMKL_CLIENT_ID: string; APP_NAME: string; APP_VERSION: string },
): URL {
  const u = new URL(url);
  u.searchParams.set("client_id", config.SIMKL_CLIENT_ID);
  u.searchParams.set("app-name", config.APP_NAME);
  u.searchParams.set("app-version", config.APP_VERSION);
  return u;
}
export function parseActivities(raw: unknown): Activities {
  const r = record(raw);
  if (r.all !== null && (!validDate(r.all) || r.all.length !== 20))
    throw Error("Invalid activity response");
  const groups: Record<string, Record<string, string | null>> = {};
  for (const name of ["tv_shows", "anime", "movies"]) {
    const value = r[name];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid activity response");
    const group: Record<string, string | null> = {};
    for (const [key, v] of Object.entries(record(value))) {
      if (v !== null && (!validDate(v) || v.length !== 20))
        throw Error("Invalid activity response");
      group[key] = v;
    }
    groups[name] = group;
  }
  return {
    all: r.all,
    tv_shows: groups.tv_shows,
    anime: groups.anime,
    movies: groups.movies,
  };
}
export class SimklClient {
  constructor(
    private dispatch: (r: DispatchRequest) => Promise<DispatchResult>,
    private now: () => number = Date.now,
  ) {}
  private async call(request: DispatchRequest): Promise<unknown> {
    const result = await this.dispatch(request);
    if (result.status < 200 || result.status >= 300)
      throw classifyFailure(result, this.now());
    return typeof result.body === "string"
      ? JSON.parse(result.body)
      : result.body;
  }
  private token(raw: unknown): TokenGrant {
    const r = record(raw);
    if (
      typeof r.access_token !== "string" ||
      !r.access_token ||
      typeof r.refresh_token !== "string" ||
      !r.refresh_token ||
      typeof r.expires_in !== "number" ||
      !Number.isFinite(r.expires_in) ||
      r.expires_in <= 0 ||
      typeof r.scope !== "string" ||
      !r.scope.split(" ").includes("media:read")
    )
      throw Error("Invalid OAuth response");
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: this.now() + r.expires_in * 1000,
      scope: r.scope,
    };
  }
  async exchange(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<TokenGrant> {
    return this.token(
      await this.call({
        path: "/oauth2/token",
        method: "POST",
        form: {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        },
      }),
    );
  }
  async refresh(grant: TokenGrant): Promise<TokenGrant> {
    return this.token(
      await this.call({
        path: "/oauth2/token",
        method: "POST",
        form: {
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
        },
      }),
    );
  }
  async identity(grant: TokenGrant): Promise<string> {
    const raw = await this.call({
      path: "/users/settings",
      method: "GET",
      token: grant.accessToken,
    });
    const id = positiveId(record(record(raw).account).id);
    if (!id) throw Error("Invalid account response");
    return String(id);
  }
  async activities(grant: TokenGrant): Promise<Activities> {
    return parseActivities(
      await this.call({
        path: "/sync/activities",
        method: "GET",
        token: grant.accessToken,
      }),
    );
  }
  async items(
    grant: TokenGrant,
    category: Category,
    query?: Record<string, string>,
  ): Promise<unknown> {
    return this.call({
      path: `/sync/all-items/${apiCategory(category)}`,
      method: "GET",
      token: grant.accessToken,
      query,
    });
  }
  async revoke(grant: TokenGrant): Promise<void> {
    await this.call({
      path: "/oauth2/revoke",
      method: "POST",
      form: { token: grant.refreshToken },
    });
  }
}
