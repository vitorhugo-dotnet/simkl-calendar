import { env, runInDurableObject, fetchMock } from "cloudflare:test";
import { expect, it, afterEach } from "vitest";
import { hashSecret } from "../src/security";
import { ChunkStore } from "../src/storage";
import tv from "./fixtures/tv.json";
afterEach(() => {
  fetchMock.deactivate();
  fetchMock.disableNetConnect();
});
const stub = () =>
  env.COORDINATOR.get(env.COORDINATOR.idFromName(crypto.randomUUID()));
it("expires and consumes bound OAuth state exactly once", async () => {
  const s = stub();
  const binding = await hashSecret("browser");
  const transaction = {
    verifier: "verifier",
    bindingHash: binding,
    expiresAt: Date.now() + 600000,
    redirectUri: "https://calendar.example/auth/callback",
  };
  await s.createOAuth("state", transaction);
  expect(await s.consumeOAuth("state", "wrong")).toBeNull();
  expect(await s.consumeOAuth("state", binding)).toEqual(transaction);
  expect(await s.consumeOAuth("state", binding)).toBeNull();
  await s.createOAuth("expired", { ...transaction, expiresAt: Date.now() - 1 });
  expect(await s.consumeOAuth("expired", binding)).toBeNull();
});
it("caches and coalesces public datasets without bearer tokens", async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  let count = 0;
  fetchMock
    .get("https://data.simkl.in")
    .intercept({
      path: (p) => p.startsWith("/calendar/v2/tv.json"),
      method: "GET",
      headers: (h) => !("authorization" in h),
    })
    .reply(() => {
      count++;
      return {
        statusCode: 200,
        data: JSON.stringify(tv),
        responseOptions: {
          headers: {
            "cache-control": "max-age=18000",
            age: "60",
            etag: '"v1"',
          },
        },
      };
    });
  const s = stub();
  const [a, b] = await Promise.all([s.dataset("tv"), s.dataset("tv")]);
  expect(a.rows).toEqual(b.rows);
  expect(count).toBe(1);
  expect((await s.dataset("tv")).rows).toEqual(a.rows);
  expect(count).toBe(1);
});
it("uses conditional headers, handles 304 and refuses expired fallback", async () => {
  const s = stub();
  await runInDurableObject(s, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    await store.write("dataset:tv", {
      rows: [],
      validatedAt: Date.now() - 3600000,
      modifiedAt: 1000,
      freshUntil: 0,
      etag: '"v1"',
    });
  });
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://data.simkl.in")
    .intercept({
      path: (p) => p.startsWith("/calendar/v2/tv.json"),
      headers: { "if-none-match": '"v1"' },
    })
    .reply(304, "", { headers: { "cache-control": "max-age=18000" } });
  expect((await s.dataset("tv")).modifiedAt).toBe(1000);
  await runInDurableObject(s, async (_instance, state) => {
    await new ChunkStore(state.storage).write("dataset:tv", {
      rows: [],
      validatedAt: Date.now() - 90000000,
      modifiedAt: 1000,
      freshUntil: 0,
    });
  });
  fetchMock
    .get("https://data.simkl.in")
    .intercept({ path: (p) => p.startsWith("/calendar/v2/tv.json") })
    .reply(500, "");
  await runInDurableObject(s, async (instance) => {
    await expect(instance.dataset("tv")).rejects.toThrow();
  });
});
it("rejects arbitrary API destinations and preserves quota cooldown", async () => {
  const s = stub();
  await runInDurableObject(s, async (instance) => {
    await expect(
      instance.dispatch({ path: "https://evil.example", method: "GET" }),
    ).rejects.toThrow();
  });
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://api.simkl.com")
    .intercept({
      path: (p) => p.startsWith("/sync/activities"),
      headers: { authorization: "Bearer private" },
      method: "GET",
    })
    .reply(
      429,
      { error: "user_limit_exceeded" },
      { headers: { "retry-after": "3600" } },
    );
  const request = {
    path: "/sync/activities",
    method: "GET" as const,
    token: "private",
  };
  expect((await s.dispatch(request)).status).toBe(429);
  expect((await s.dispatch(request)).status).toBe(429);
  await runInDurableObject(s, async (_instance, state) => {
    const values = JSON.stringify([...(await state.storage.list())]);
    expect(values).not.toContain("private");
  });
});
it("backs off a cold failed dataset instead of refetching on every request", async () => {
  const s = stub();
  fetchMock.activate();
  fetchMock.disableNetConnect();
  let calls = 0;
  fetchMock
    .get("https://data.simkl.in")
    .intercept({ path: (p) => p.startsWith("/calendar/v2/anime.json") })
    .reply(() => {
      calls++;
      return { statusCode: 503, data: "{}" };
    })
    .persist();
  await runInDurableObject(s, async (instance) => {
    await expect(instance.dataset("anime")).rejects.toThrow();
    await expect(instance.dataset("anime")).rejects.toThrow();
  });
  expect(calls).toBe(1);
});
it("spaces uncached GET dispatch and sends identity headers", async () => {
  const s = stub();
  const times: number[] = [];
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://api.simkl.com")
    .intercept({
      path: (p) =>
        p.includes("client_id=client") && p.includes("app-name=simkl-calendar"),
      method: "GET",
      headers: { "user-agent": "simkl-calendar/0.1.0" },
    })
    .reply(() => {
      times.push(Date.now());
      return { statusCode: 200, data: "{}" };
    })
    .persist();
  await Promise.all([
    s.dispatch({ method: "GET", path: "/sync/activities", token: "a" }),
    s.dispatch({ method: "GET", path: "/sync/activities", token: "b" }),
  ]);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
});
