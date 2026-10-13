import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { expect, it, beforeEach, afterEach } from "vitest";
import app from "../src/index";
import { accountAddress } from "../src/security";
import { ChunkStore } from "../src/storage";
const origin = "https://calendar.example";
const bindings = { ...env, APP_ORIGIN: origin };
const request = (path: string, init?: RequestInit, overrides = {}) =>
  app.fetch(new Request(origin + path, init), { ...bindings, ...overrides });
const getCookie = (response: Response, name: string) =>
  response.headers.get("set-cookie")!.match(new RegExp(`${name}=([^;]+)`))![1];
beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.deactivate());
async function connected() {
  const identity = String(Math.floor(Math.random() * 1e9) + 1);
  const address = await accountAddress(identity, env.ACCOUNT_LOOKUP_KEY);
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(address));
  const { session } = await stub.attach(identity, {
    accessToken: "private-oauth-token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 604800000,
    scope: "media:read",
  });
  const view = (await stub.view(session))!;
  await stub.mutate(session, view.csrf, {
    type: "preferences",
    preferences: { categories: [], statuses: [] },
  });
  return {
    stub,
    view,
    session,
    cookie: `sc_session=${address}.${session}`,
    address,
  };
}
it("home explains connection, health reveals no secrets and unauthorized account redirects", async () => {
  expect((await request("/")).status).toBe(200);
  expect(await (await request("/")).text()).toContain("Connect Simkl");
  expect(await (await request("/health")).text()).toBe("ok");
  expect((await request("/account")).status).toBe(302);
});
it("login uses PKCE, read-only scope, canonical redirect and secure cookie", async () => {
  const r = await request("/auth/login", { headers: { host: "evil.example" } });
  expect(r.status).toBe(302);
  const u = new URL(r.headers.get("location")!);
  expect(u.origin).toBe("https://simkl.com");
  expect(u.searchParams.get("scope")).toBe("media:read");
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("redirect_uri")).toBe(origin + "/auth/callback");
  expect(r.headers.get("set-cookie")).toContain("Secure");
  expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
});
it("rejects issuer/state/binding mismatch and duplicate callback parameters", async () => {
  const login = await request("/auth/login");
  const u = new URL(login.headers.get("location")!);
  const state = u.searchParams.get("state");
  const cookie = `sc_oauth=${getCookie(login, "sc_oauth")}`;
  expect(
    (
      await request(
        `/auth/callback?state=${state}&iss=https://evil.example&code=c`,
        { headers: { cookie } },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/auth/callback?state=${state}&iss=https://simkl.com&code=c`,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/auth/callback?state=${state}&state=${state}&iss=https://simkl.com&code=c`,
        { headers: { cookie } },
      )
    ).status,
  ).toBe(400);
});
it("completes OAuth once and consumes state even when replayed", async () => {
  const login = await request("/auth/login");
  const u = new URL(login.headers.get("location")!);
  const state = u.searchParams.get("state");
  const cookie = `sc_oauth=${getCookie(login, "sc_oauth")}`;
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/oauth2/token"), method: "POST" })
    .reply(200, {
      access_token: "private",
      refresh_token: "refresh",
      expires_in: 604800,
      scope: "media:read",
    });
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/users/settings") })
    .reply(200, { account: { id: Math.floor(Math.random() * 1e9) + 1 } });
  const path = `/auth/callback?state=${state}&iss=https://simkl.com&code=c`;
  const callback = await request(path, { headers: { cookie } });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(origin + "/account");
  expect(callback.headers.get("set-cookie")).toContain("sc_session=");
  expect((await request(path, { headers: { cookie } })).status).toBe(400);
});
it("displays four canonical URLs and protects mutations with origin/session CSRF", async () => {
  const a = await connected();
  const page = await request("/account", {
    headers: { cookie: a.cookie, host: "evil.example" },
  });
  const html = await page.text();
  for (const category of ["all", "tv", "anime", "movies"])
    expect(html).toContain(
      `${origin}/feeds/${a.address}/${a.view.secret}/${category}.ics`,
    );
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(html).not.toContain("private-oauth-token");
  const body = new URLSearchParams({ csrf: a.view.csrf });
  expect(
    (
      await request("/account/revoke", {
        method: "POST",
        headers: { cookie: a.cookie, origin: "https://evil.example" },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/account/revoke", {
        method: "POST",
        headers: { cookie: a.cookie, origin },
        body: new URLSearchParams({ csrf: "wrong" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/account/revoke", {
        method: "POST",
        headers: { cookie: a.cookie, origin },
        body,
      })
    ).status,
  ).toBe(302);
  expect(await a.stub.feed(a.view.secret!, "all")).toBeNull();
});
it("feeds enforce live secrets, private caching and rotation", async () => {
  const a = await connected();
  const path = `/feeds/${a.address}/${a.view.secret}/all.ics`;
  const r = await request(path);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(await r.text()).toContain("BEGIN:VCALENDAR");
  expect((await request(`/feeds/${a.address}/wrong/all.ics`)).status).toBe(404);
  await a.stub.mutate(a.session, a.view.csrf, { type: "rotate" });
  expect((await request(path)).status).toBe(404);
});
it("escapes HTML, rejects oversized forms and clears session cookies on logout", async () => {
  const a = await connected();
  await runInDurableObject(a.stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = await store.read<Record<string, unknown>>("account");
    value!.preferences = {
      categories: ["<script>alert(1)</script>"],
      statuses: [],
    };
    await store.write("account", value);
  });
  expect(
    await (await request("/account", { headers: { cookie: a.cookie } })).text(),
  ).not.toContain("<script>");
  expect(
    (
      await request("/account/preferences", {
        method: "POST",
        headers: {
          cookie: a.cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "csrf=" + a.view.csrf + "&foo=" + "a".repeat(9000),
      })
    ).status,
  ).toBe(413);
  const r = await request("/auth/logout", {
    method: "POST",
    headers: { cookie: a.cookie, origin },
    body: new URLSearchParams({ csrf: a.view.csrf }),
  });
  expect(r.status).toBe(302);
  expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await a.stub.view(a.session)).toBeNull();
});
it("denied consent consumes state and expired transactions reject sign-in", async () => {
  const login = await request("/auth/login");
  const u = new URL(login.headers.get("location")!);
  const state = u.searchParams.get("state")!;
  const cookie = `sc_oauth=${getCookie(login, "sc_oauth")}`;
  expect(
    (
      await request(
        `/auth/callback?state=${state}&iss=https://simkl.com&error=access_denied`,
        { headers: { cookie } },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/auth/callback?state=${state}&iss=https://simkl.com&code=c`,
        { headers: { cookie } },
      )
    ).status,
  ).toBe(400);
  const expired = await request("/auth/login");
  const query = new URL(expired.headers.get("location")!).searchParams;
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("global"));
  await runInDurableObject(coordinator, async (_instance, state) => {
    for (const [key, value] of await state.storage.list<{ expiresAt: number }>({
      prefix: "oauth:",
    })) {
      await state.storage.put(key, { ...value, expiresAt: 0 });
    }
  });
  expect(
    (
      await request(
        `/auth/callback?state=${query.get("state")}&iss=https://simkl.com&code=c`,
        { headers: { cookie: `sc_oauth=${getCookie(expired, "sc_oauth")}` } },
      )
    ).status,
  ).toBe(400);
});
it("wrong scope cannot establish a browser session", async () => {
  const login = await request("/auth/login");
  const u = new URL(login.headers.get("location")!);
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/oauth2/token"), method: "POST" })
    .reply(200, {
      access_token: "private",
      refresh_token: "refresh",
      expires_in: 604800,
      scope: "media:write",
    });
  const result = await request(
    `/auth/callback?state=${u.searchParams.get("state")}&iss=https://simkl.com&code=c`,
    { headers: { cookie: `sc_oauth=${getCookie(login, "sc_oauth")}` } },
  );
  expect(result.status).toBe(502);
  expect(result.headers.get("set-cookie")).not.toContain("sc_session");
});
it("failed required dataset yields 503 rather than an empty successful calendar", async () => {
  const a = await connected();
  await a.stub.mutate(a.session, a.view.csrf, {
    type: "preferences",
    preferences: { categories: ["anime"], statuses: ["watching"] },
  });
  const timestamp = "2026-10-13T12:00:00Z";
  await runInDurableObject(a.stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = await store.read<Record<string, unknown>>("account");
    value!.snapshot = {
      items: [{ category: "anime", id: 42, status: "watching", title: "A" }],
      activities: { all: timestamp, tv_shows: {}, anime: {}, movies: {} },
      validatedAt: Date.now(),
    };
    await store.write("account", value);
  });
  fetchMock
    .get("https://data.simkl.in")
    .intercept({ path: (p) => p.startsWith("/calendar/v2/anime.json") })
    .reply(503, {});
  const result = await request(`/feeds/${a.address}/${a.view.secret}/all.ics`);
  expect(result.status).toBe(503);
  expect(result.headers.get("retry-after")).toBe("60");
  expect(await result.text()).not.toContain("BEGIN:VCALENDAR");
});
