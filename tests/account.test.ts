import { env, runInDurableObject, fetchMock } from "cloudflare:test";
import { expect, it, afterEach, beforeEach } from "vitest";
import { accountAddress, hashSecret } from "../src/security";
import { ChunkStore } from "../src/storage";
import { Account } from "../src/account";
const grant = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 604800000,
  scope: "media:read",
};
async function account() {
  const identity = String(Math.floor(Math.random() * 1e9) + 1);
  const address = await accountAddress(identity, env.ACCOUNT_LOOKUP_KEY);
  return { identity, stub: env.ACCOUNT.get(env.ACCOUNT.idFromName(address)) };
}
beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/oauth2/revoke"), method: "POST" })
    .reply(503, {})
    .persist();
});
afterEach(() => {
  fetchMock.deactivate();
  fetchMock.disableNetConnect();
});
it("stores encrypted tokens, hashed expiring sessions and isolates accounts", async () => {
  const a = await account(),
    b = await account();
  const connection = await a.stub.attach(a.identity, grant);
  const v = await a.stub.view(connection.session);
  expect(v?.connected).toBe(true);
  expect(v?.secret).toMatch(/^[\w-]{43}$/);
  expect(await b.stub.view(connection.session)).toBeNull();
  expect(await a.stub.view(v!.secret!)).toBeNull();
  await runInDurableObject(a.stub, async (_instance, state) => {
    const raw = JSON.stringify([...(await state.storage.list())]);
    expect(raw).not.toContain("private-access");
    expect(raw).not.toContain("private-refresh");
    expect(raw).not.toContain(connection.session);
    const store = new ChunkStore(state.storage);
    const value = await store.read<{
      sessions: { hash: string; expiresAt: number }[];
    }>("account");
    value!.sessions[0].expiresAt = Date.now() - 1;
    await store.write("account", value);
  });
  expect(await a.stub.view(connection.session)).toBeNull();
});
it("rotates/revokes immediately and does not restore revoked feeds on reconnect", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, grant);
  const first = (await a.stub.view(session))!;
  await a.stub.mutate(session, first.csrf, { type: "rotate" });
  const second = (await a.stub.view(session))!;
  expect(second.secret).not.toBe(first.secret);
  expect(await a.stub.feed(first.secret!, "all")).toBeNull();
  await a.stub.mutate(session, second.csrf, { type: "revoke" });
  expect(await a.stub.feed(second.secret!, "all")).toBeNull();
  const reconnect = await a.stub.attach(a.identity, grant);
  expect((await a.stub.view(reconnect.session))?.secret).toBeNull();
  await runInDurableObject(a.stub, async (_instance, state) => {
    const fresh = new Account(state, env);
    expect((await fresh.view(reconnect.session))?.secret).toBeNull();
  });
});
it("enforces CSRF, rejects unauthorized feeds without upstream work and disconnects locally", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, grant);
  const v = (await a.stub.view(session))!;
  await runInDurableObject(a.stub, async (instance) => {
    await expect(
      instance.mutate(session, "wrong", { type: "revoke" }),
    ).rejects.toThrow();
  });
  expect(await a.stub.feed("wrong", "all")).toBeNull();
  await a.stub.mutate(session, v.csrf, { type: "disconnect" });
  expect(await a.stub.view(session)).toBeNull();
  expect(await a.stub.feed(v.secret!, "all")).toBeNull();
});
it("produces valid empty feeds without fetching disabled datasets", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, grant);
  const v = (await a.stub.view(session))!;
  await a.stub.mutate(session, v.csrf, {
    type: "preferences",
    preferences: { categories: [], statuses: [] },
  });
  const feed = await a.stub.feed(v.secret!, "all");
  expect(feed?.body).toContain("BEGIN:VCALENDAR");
  expect(feed?.body).not.toContain("BEGIN:VEVENT");
});
it("serves only the owning user watchlist and coalesces concurrent refresh", async () => {
  const a = await account(),
    b = await account();
  const ac = await a.stub.attach(a.identity, grant),
    bc = await b.stub.attach(b.identity, {
      ...grant,
      accessToken: "b-private",
    });
  const av = (await a.stub.view(ac.session))!,
    bv = (await b.stub.view(bc.session))!;
  await a.stub.mutate(ac.session, av.csrf, {
    type: "preferences",
    preferences: { categories: ["tv"], statuses: ["watching"] },
  });
  await b.stub.mutate(bc.session, bv.csrf, {
    type: "preferences",
    preferences: { categories: [], statuses: [] },
  });
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const timestamp = "2026-10-13T12:00:00Z";
  let activityCalls = 0;
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/sync/activities") })
    .reply(() => {
      activityCalls++;
      return {
        statusCode: 200,
        data: JSON.stringify({
          all: timestamp,
          tv_shows: { watching: timestamp },
          anime: {},
          movies: {},
        }),
      };
    });
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/sync/all-items/shows") })
    .reply(200, {
      shows: [
        { status: "watching", show: { ids: { simkl: 1 }, title: "User A" } },
      ],
    });
  for (const category of ["anime", "movies"])
    fetchMock
      .get("https://api.simkl.com")
      .intercept({ path: (p) => p.startsWith(`/sync/all-items/${category}`) })
      .reply(200, {});
  fetchMock
    .get("https://data.simkl.in")
    .intercept({ path: (p) => p.startsWith("/calendar/v2/tv.json") })
    .reply(
      200,
      {
        calendar: [
          {
            simkl_id: 1,
            date: "2026-10-20T12:00:00Z",
            episode: { season: 1, episode: 1 },
          },
        ],
        metadata: { "1": { title: "User A" } },
      },
      { headers: { "cache-control": "max-age=18000" } },
    );
  const feeds = await Promise.all([
    a.stub.feed(av.secret!, "all"),
    a.stub.feed(av.secret!, "tv"),
  ]);
  expect(feeds[0]?.body).toContain("User A");
  expect(feeds[1]?.body).toContain("User A");
  expect(activityCalls).toBe(1);
  expect((await b.stub.feed(bv.secret!, "all"))?.body).not.toContain("User A");
  expect(await b.stub.feed(av.secret!, "all")).toBeNull();
});
it("refreshes an expired grant once for simultaneous empty-watchlist feeds", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, {
    ...grant,
    expiresAt: 0,
  });
  const v = (await a.stub.view(session))!;
  await a.stub.mutate(session, v.csrf, {
    type: "preferences",
    preferences: { categories: ["tv"], statuses: ["watching"] },
  });
  let refreshCalls = 0;
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/oauth2/token"), method: "POST" })
    .reply(() => {
      refreshCalls++;
      return {
        statusCode: 200,
        data: JSON.stringify({
          access_token: "new-access",
          refresh_token: grant.refreshToken,
          expires_in: 604800,
          scope: "media:read",
        }),
      };
    });
  const ts = "2026-10-13T12:00:00Z";
  fetchMock
    .get("https://api.simkl.com")
    .intercept({
      path: (p) => p.startsWith("/sync/activities"),
      headers: { authorization: "Bearer new-access" },
    })
    .reply(200, { all: ts, tv_shows: {}, anime: {}, movies: {} });
  for (const category of ["shows", "anime", "movies"])
    fetchMock
      .get("https://api.simkl.com")
      .intercept({ path: (p) => p.startsWith(`/sync/all-items/${category}`) })
      .reply(200, {});
  const feeds = await Promise.all([
    a.stub.feed(v.secret!, "tv"),
    a.stub.feed(v.secret!, "all"),
  ]);
  expect(refreshCalls).toBe(1);
  expect(feeds[0]?.body).not.toContain("BEGIN:VEVENT");
  expect(feeds[1]?.body).toBe(feeds[0]?.body);
});
it("failed invalid refresh closes feed authority rather than serving stale private data", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, {
    ...grant,
    expiresAt: 0,
  });
  const v = (await a.stub.view(session))!;
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/oauth2/token"), method: "POST" })
    .reply(400, { error: "invalid_grant" });
  await runInDurableObject(a.stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = await store.read<Record<string, unknown>>("account");
    value!.snapshot = {
      items: [],
      activities: {
        all: "2026-10-13T12:00:00Z",
        tv_shows: {},
        anime: {},
        movies: {},
      },
      validatedAt: Date.now() - 3600000,
    };
    await store.write("account", value);
  });
  expect(await a.stub.feed(v.secret!, "all")).toBeNull();
  expect((await a.stub.view(session))?.connected).toBe(false);
  expect((await a.stub.view(session))?.secret).toBeNull();
});
it("persists quota cooldown and stops stale fallback after 24 hours", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, grant);
  const v = (await a.stub.view(session))!;
  await a.stub.mutate(session, v.csrf, {
    type: "preferences",
    preferences: { categories: ["tv"], statuses: ["watching"] },
  });
  await runInDurableObject(a.stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = await store.read<Record<string, unknown>>("account");
    value!.snapshot = {
      items: [],
      activities: {
        all: "2026-10-13T12:00:00Z",
        tv_shows: {},
        anime: {},
        movies: {},
      },
      validatedAt: Date.now() - 3600000,
    };
    await store.write("account", value);
  });
  let calls = 0;
  fetchMock
    .get("https://api.simkl.com")
    .intercept({ path: (p) => p.startsWith("/sync/activities") })
    .reply(() => {
      calls++;
      return {
        statusCode: 429,
        data: JSON.stringify({ error: "user_limit_exceeded" }),
        responseOptions: { headers: { "retry-after": "3600" } },
      };
    })
    .persist();
  expect((await a.stub.feed(v.secret!, "all"))?.body).toContain(
    "BEGIN:VCALENDAR",
  );
  await a.stub.mutate(session, v.csrf, { type: "refresh" });
  expect(calls).toBe(1);
  expect((await a.stub.view(session))?.degraded).toBe(true);
  await runInDurableObject(a.stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = await store.read<{ snapshot: { validatedAt: number } }>(
      "account",
    );
    value!.snapshot.validatedAt = Date.now() - 90000000;
    await store.write("account", value);
    const fresh = new Account(state, env);
    await expect(fresh.feed(v.secret!, "all")).rejects.toThrow();
  });
  expect(calls).toBe(1);
});
it("serializes feed authorization with concurrent revocation", async () => {
  const a = await account();
  const { session } = await a.stub.attach(a.identity, grant);
  const v = (await a.stub.view(session))!;
  await a.stub.mutate(session, v.csrf, {
    type: "preferences",
    preferences: { categories: [], statuses: [] },
  });
  await Promise.all([
    a.stub.feed(v.secret!, "all"),
    a.stub.mutate(session, v.csrf, { type: "revoke" }),
  ]);
  expect(await a.stub.feed(v.secret!, "all")).toBeNull();
});
