import { expect, it } from "vitest";
import {
  normalizeDataset,
  normalizeWatchlist,
  selectEvents,
} from "../src/calendar";
import { DEFAULT_PREFERENCES } from "../src/domain";
import type { ScheduleRow, WatchItem } from "../src/domain";
import tv from "./fixtures/tv.json";
import anime from "./fixtures/anime.json";
import movies from "./fixtures/movies.json";
const row: ScheduleRow = {
  category: "tv",
  id: 1,
  date: "2026-10-20T12:00:00Z",
  title: "A",
  url: "https://simkl.com/tv/1",
  season: 0,
  episode: 1,
  runtimeMinutes: 25,
};
const item: WatchItem = {
  category: "tv",
  id: 1,
  title: "A",
  status: "watching",
};
it("reads actual V2 envelopes and Simkl watchlist IDs", () => {
  for (const [category, raw] of [
    ["tv", tv],
    ["anime", anime],
    ["movies", movies],
  ] as const) {
    expect(normalizeDataset(category, raw)[0].id).toBe(
      raw.calendar[0].simkl_id,
    );
  }
  expect(
    normalizeWatchlist("tv", {
      shows: [{ status: "watching", show: { title: "A", ids: { simkl: 1 } } }],
    }),
  ).toEqual([item]);
  expect(normalizeWatchlist("movies", {})).toEqual([]);
  expect(
    normalizeWatchlist("movies", {
      movies: [{ status: "watching", movie: { ids: { simkl: 1 } } }],
    }),
  ).toEqual([]);
});
it("rejects malformed roots and skips malformed rows or dates", () => {
  expect(() => normalizeDataset("tv", [])).toThrow();
  expect(() => normalizeWatchlist("tv", { shows: "bad" })).toThrow();
  expect(
    selectEvents(
      [
        { ...row, date: "2026-02-30T12:00:00Z" },
        { ...row, date: "" },
      ],
      [item],
      DEFAULT_PREFERENCES,
      "all",
    ),
  ).toEqual([]);
  expect(
    normalizeDataset("tv", {
      calendar: [null, { simkl_id: -1 }],
      metadata: {},
    }),
  ).toEqual([]);
});
it("filters categories and all statuses without cross-category matching", () => {
  for (const status of [
    "watching",
    "plantowatch",
    "hold",
    "completed",
    "dropped",
  ] as const) {
    expect(
      selectEvents(
        [row],
        [{ ...item, status }],
        { categories: ["tv"], statuses: [status] },
        "all",
      ),
    ).toHaveLength(1);
  }
  expect(
    selectEvents(
      [row],
      [{ ...item, category: "anime" }],
      DEFAULT_PREFERENCES,
      "all",
    ),
  ).toEqual([]);
  expect(
    selectEvents([row], [item], { categories: [], statuses: [] }, "all"),
  ).toEqual([]);
  expect(selectEvents([row], [item], DEFAULT_PREFERENCES, "movies")).toEqual(
    [],
  );
});
it("retains UID across date/title changes and distinguishes season zero from absent", () => {
  const a = selectEvents([row], [item], DEFAULT_PREFERENCES, "all")[0];
  const b = selectEvents(
    [{ ...row, title: "B", date: "2026-10-22T12:00:00Z" }],
    [item],
    DEFAULT_PREFERENCES,
    "all",
  )[0];
  expect(a.uid).toBe(b.uid);
  expect(a.start).not.toBe(b.start);
  expect(a.uid).not.toBe(
    selectEvents(
      [{ ...row, season: undefined }],
      [item],
      DEFAULT_PREFERENCES,
      "all",
    )[0].uid,
  );
  expect(a.end).toBe("2026-10-20T12:25:00Z");
});
it("deduplicates by identity with stable tie-breaking and latest schedule instant", () => {
  const rows = [
    row,
    { ...row, title: "B" },
    { ...row, date: "2026-10-22T12:00:00Z" },
  ];
  expect(selectEvents(rows, [item], DEFAULT_PREFERENCES, "all")).toEqual(
    selectEvents([...rows].reverse(), [item], DEFAULT_PREFERENCES, "all"),
  );
  expect(selectEvents(rows, [item], DEFAULT_PREFERENCES, "all")).toHaveLength(
    1,
  );
  expect(selectEvents(rows, [item], DEFAULT_PREFERENCES, "all")[0].start).toBe(
    "2026-10-22T12:00:00Z",
  );
});
it("handles release identities, sparse metadata and safe links", () => {
  expect(
    normalizeDataset("tv", {
      calendar: [
        {
          simkl_id: 1,
          date: row.date,
          episode: { season: 0, episode: 1, url: "javascript:evil" },
        },
      ],
      metadata: { "1": {} },
    })[0].url,
  ).toBe("https://simkl.com/tv/1/");
  const release = {
    ...row,
    category: "anime" as const,
    episode: undefined,
    animeMovie: true,
  };
  expect(
    selectEvents(
      [release],
      [{ ...item, category: "anime" }],
      DEFAULT_PREFERENCES,
      "all",
    ),
  ).toHaveLength(1);
  expect(
    selectEvents(
      [{ ...release, animeMovie: false }],
      [{ ...item, category: "anime" }],
      DEFAULT_PREFERENCES,
      "all",
    ),
  ).toEqual([]);
});
