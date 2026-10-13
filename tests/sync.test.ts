import fresh from "./fixtures/activities-fresh_user.json";
import partial from "./fixtures/activities-partial_user.json";
import { expect, it } from "vitest";
import { syncWatchlist } from "../src/sync";
import { SimklClient } from "../src/simkl";
import type { Activities, DispatchRequest, WatchSnapshot } from "../src/domain";
const before = "2026-10-13T12:00:00Z",
  after = "2026-10-13T13:00:00Z";
const activities: Activities = {
  all: before,
  tv_shows: { all: before, watching: before, removed_from_list: before },
  anime: { all: before, plantowatch: before, removed_from_list: before },
  movies: { all: before, plantowatch: before, removed_from_list: before },
};
const grant = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1e15,
  scope: "media:read",
};
const snapshot: WatchSnapshot = {
  items: [
    { category: "tv", id: 1, status: "watching", title: "A" },
    { category: "tv", id: 2, status: "plantowatch", title: "B" },
  ],
  activities,
  validatedAt: 0,
};
it("reads activities first and initial libraries sequentially before saving snapshot", async () => {
  const calls: string[] = [];
  const client = new SimklClient(async (r) => {
    calls.push(r.path);
    return {
      status: 200,
      body: r.path === "/sync/activities" ? activities : {},
      headers: {},
    };
  });
  const next = await syncWatchlist(client, grant, null, 1000);
  expect(calls).toEqual([
    "/sync/activities",
    "/sync/all-items/shows",
    "/sync/all-items/anime",
    "/sync/all-items/movies",
  ]);
  expect(next.activities).toEqual(activities);
  expect(next.validatedAt).toBe(1000);
  expect(next.items).toEqual([]);
});
it("unchanged or unrelated activity changes never fetch membership", async () => {
  const calls: DispatchRequest[] = [];
  const client = new SimklClient(async (r) => {
    calls.push(r);
    return {
      status: 200,
      body: {
        ...activities,
        all: after,
        tv_shows: { ...activities.tv_shows, all: after, rated_at: after },
      },
      headers: {},
    };
  });
  const next = await syncWatchlist(client, grant, snapshot, 1000);
  expect(calls).toHaveLength(1);
  expect(next.items).toEqual(snapshot.items);
  expect(next.validatedAt).toBe(1000);
});
it("merges changed status using exact previous all and reconciles deletions", async () => {
  const calls: DispatchRequest[] = [];
  const client = new SimklClient(async (r) => {
    calls.push(r);
    return {
      status: 200,
      headers: {},
      body:
        r.path === "/sync/activities"
          ? {
              ...activities,
              all: after,
              tv_shows: {
                ...activities.tv_shows,
                watching: after,
                removed_from_list: after,
              },
            }
          : r.query?.extended === "simkl_ids_only"
            ? { shows: [{ show: { ids: { simkl: 1 } } }] }
            : {
                shows: [
                  { status: "hold", show: { title: "A", ids: { simkl: 1 } } },
                ],
              },
    };
  });
  const next = await syncWatchlist(client, grant, snapshot, 1000);
  expect(next.items).toEqual([
    { category: "tv", id: 1, title: "A", status: "hold" },
  ]);
  expect(calls[1].query).toEqual({ date_from: before });
  expect(calls[2].query).toEqual({ extended: "simkl_ids_only" });
  expect(snapshot.items).toHaveLength(2);
});
it("partial upstream failure cannot mutate or advance the previous snapshot", async () => {
  const old = JSON.stringify(snapshot);
  const client = new SimklClient(async (r) => ({
    status: r.path.includes("/anime") ? 503 : 200,
    headers: {},
    body:
      r.path === "/sync/activities"
        ? {
            ...activities,
            all: after,
            tv_shows: { ...activities.tv_shows, watching: after },
            anime: { ...activities.anime, plantowatch: after },
          }
        : {
            shows: [
              { status: "hold", show: { title: "changed", ids: { simkl: 1 } } },
            ],
          },
  }));
  await expect(syncWatchlist(client, grant, snapshot, 1000)).rejects.toThrow();
  expect(JSON.stringify(snapshot)).toBe(old);
});
it("malformed activities and deletion inventories fail without erasing cache", async () => {
  const malformed = new SimklClient(async () => ({
    status: 200,
    headers: {},
    body: { all: "invalid" },
  }));
  await expect(syncWatchlist(malformed, grant, snapshot, 1000)).rejects.toThrow(
    "Invalid activity",
  );
  const client = new SimklClient(async (r) => ({
    status: 200,
    headers: {},
    body:
      r.path === "/sync/activities"
        ? {
            ...activities,
            all: after,
            tv_shows: { ...activities.tv_shows, removed_from_list: after },
          }
        : { shows: "bad" },
  }));
  await expect(syncWatchlist(client, grant, snapshot, 1000)).rejects.toThrow();
});

it("syncs official fresh-user null timestamps and later membership without date_from=null", async () => {
  let activity: unknown = fresh;
  const calls: DispatchRequest[] = [];
  const client = new SimklClient(async (r) => {
    calls.push(r);
    return {
      status: 200,
      headers: {},
      body:
        r.path === "/sync/activities"
          ? activity
          : r.path.endsWith("/shows") && activity !== fresh
            ? {
                shows: [
                  {
                    status: "watching",
                    show: { title: "New", ids: { simkl: 42 } },
                  },
                ],
              }
            : {},
    };
  });
  const first = await syncWatchlist(client, grant, null, 1000);
  expect(first.activities.all).toBeNull();
  expect(first.items).toEqual([]);
  calls.length = 0;
  const unchanged = await syncWatchlist(client, grant, first, 2000);
  expect(calls).toHaveLength(1);
  expect(unchanged.items).toEqual([]);
  calls.length = 0;
  activity = {
    ...fresh,
    all: after,
    tv_shows: { ...fresh.tv_shows, all: after, watching: after },
  };
  const next = await syncWatchlist(client, grant, first, 3000);
  expect(calls.map((r) => r.path)).toEqual([
    "/sync/activities",
    "/sync/all-items/shows",
  ]);
  expect(calls[1].query).toBeUndefined();
  expect(next.items[0].id).toBe(42);
});
it("syncs official partially active null buckets and ignores unrelated changes", async () => {
  const calls: DispatchRequest[] = [];
  let activity: unknown = partial;
  const client = new SimklClient(async (r) => {
    calls.push(r);
    return {
      status: 200,
      headers: {},
      body:
        r.path === "/sync/activities"
          ? activity
          : r.path.endsWith("/shows")
            ? {
                shows: [
                  {
                    status: "watching",
                    show: { title: "Existing", ids: { simkl: 42 } },
                  },
                ],
              }
            : {},
    };
  });
  const first = await syncWatchlist(client, grant, null, 1000);
  expect(first.items).toHaveLength(1);
  calls.length = 0;
  activity = {
    ...partial,
    all: after,
    tv_shows: { ...partial.tv_shows, rated_at: after, all: after },
  };
  expect((await syncWatchlist(client, grant, first, 2000)).items).toEqual(
    first.items,
  );
  expect(calls).toHaveLength(1);
});
