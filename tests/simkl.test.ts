import { expect, it } from "vitest";
import {
  SimklClient,
  UpstreamError,
  identifiedUrl,
  classifyFailure,
} from "../src/simkl";
import type { DispatchRequest, TokenGrant } from "../src/domain";
const grant: TokenGrant = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 10000,
  scope: "media:read",
};
it("exchanges once with PKCE/read-only scope and resolves stable account.id", async () => {
  const requests: DispatchRequest[] = [];
  const client = new SimklClient(
    async (r) => {
      requests.push(r);
      return {
        status: 200,
        body:
          r.path === "/oauth2/token"
            ? {
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 604800,
                scope: "media:read",
              }
            : { account: { id: 123 }, user: { name: "changeable" } },
        headers: {},
      };
    },
    () => 1000,
  );
  expect(
    (
      await client.exchange(
        "code",
        "verifier",
        "https://calendar.example/auth/callback",
      )
    ).expiresAt,
  ).toBe(604801000);
  expect(requests[0].form).toMatchObject({
    grant_type: "authorization_code",
    code_verifier: "verifier",
    redirect_uri: "https://calendar.example/auth/callback",
  });
  expect(await client.identity(grant)).toBe("123");
  expect(requests[1].method).toBe("GET");
});
it("rejects invalid tokens/scope and never exposes upstream secret payloads", async () => {
  let count = 0;
  const client = new SimklClient(async () => {
    count++;
    return {
      status: 400,
      body: { error: "invalid_grant", access_token: "secret" },
      headers: {},
    };
  });
  await expect(client.exchange("c", "v", "https://a")).rejects.toThrow(
    "Upstream request failed",
  );
  expect(count).toBe(1);
  const wrong = new SimklClient(async () => ({
    status: 200,
    body: {
      access_token: "secret",
      refresh_token: "r",
      expires_in: 1,
      scope: "media:write",
    },
    headers: {},
  }));
  await expect(wrong.exchange("c", "v", "https://a")).rejects.toThrow(
    "Invalid OAuth response",
  );
});
it("maps sync endpoints and builds required identification parameters", async () => {
  const calls: DispatchRequest[] = [];
  const client = new SimklClient(async (r) => {
    calls.push(r);
    return { status: 200, body: {}, headers: {} };
  });
  await client.items(grant, "tv", { date_from: "exact" });
  expect(calls[0]).toMatchObject({
    path: "/sync/all-items/shows",
    token: "access",
    query: { date_from: "exact" },
  });
  const url = identifiedUrl("https://data.simkl.in/calendar/v2/tv.json", {
    SIMKL_CLIENT_ID: "client",
    APP_NAME: "app",
    APP_VERSION: "1",
  });
  expect(url.searchParams.get("client_id")).toBe("client");
  expect(url.searchParams.get("app-name")).toBe("app");
});
it("classifies daily versus burst rate limits and 401", () => {
  const daily = classifyFailure(
    {
      status: 429,
      body: { error: "user_limit_exceeded" },
      headers: { "retry-after": "3600" },
    },
    1000,
  );
  expect(daily).toBeInstanceOf(UpstreamError);
  expect(daily.retryAt).toBe(3601000);
  expect(daily.kind).toBe("quota");
  expect(
    classifyFailure(
      {
        status: 429,
        body: { error: "rate_limit" },
        headers: { "retry-after": "3600" },
      },
      1000,
    ).retryAt,
  ).toBe(2000);
  expect(classifyFailure({ status: 401, body: {}, headers: {} }, 0).kind).toBe(
    "auth",
  );
});
