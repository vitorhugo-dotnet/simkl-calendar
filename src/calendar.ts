import { record, positiveId, STATUSES } from "./domain";
import type {
  Category,
  ScheduleRow,
  WatchItem,
  Preferences,
  FeedCategory,
  CalendarEvent,
  Status,
} from "./domain";
export const apiCategory = (category: Category) =>
  category === "tv" ? "shows" : category;
export function validDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(value)
  )
    return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString().replace(".000", "").startsWith(value);
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
export function safeLink(
  value: unknown,
  category: Category,
  id: number,
): string {
  if (typeof value === "string")
    try {
      const url = new URL(value, "https://simkl.com");
      if (
        url.protocol === "https:" &&
        url.hostname === "simkl.com" &&
        !url.username &&
        !url.password &&
        !url.port
      )
        return url.href;
    } catch {}
  return `https://simkl.com/${category}/${id}/`;
}
export function normalizeDataset(
  category: Category,
  raw: unknown,
): ScheduleRow[] {
  const root = record(raw);
  if (
    !Array.isArray(root.calendar) ||
    !root.metadata ||
    typeof root.metadata !== "object" ||
    Array.isArray(root.metadata)
  )
    throw Error("Invalid calendar dataset");
  const metadata = record(root.metadata);
  const rows: ScheduleRow[] = [];
  for (const value of root.calendar) {
    const e = record(value);
    const id = positiveId(e.simkl_id);
    if (!id || !validDate(e.date)) continue;
    const m = record(metadata[String(id)]);
    const episode = record(e.episode);
    rows.push({
      category,
      id,
      date: e.date,
      title: typeof m.title === "string" ? m.title : "",
      url: safeLink(episode.url ?? m.url, category, id),
      season: integer(episode.season),
      episode: positiveId(episode.episode) ?? undefined,
      episodeTitle:
        typeof episode.title === "string" ? episode.title : undefined,
      runtimeMinutes: positiveId(episode.runtime) ?? undefined,
      finale: [1, 2, 3].includes(Number(e.finale_type))
        ? (e.finale_type as 1 | 2 | 3)
        : undefined,
      animeMovie: m.anime_type === "movie",
    });
  }
  return rows;
}
export function normalizeWatchlist(
  category: Category,
  raw: unknown,
): WatchItem[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Invalid watchlist");
  const values = record(raw)[apiCategory(category)];
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw Error("Invalid watchlist");
  const items = new Map<number, WatchItem>();
  for (const value of values) {
    const e = record(value);
    const media = record(e[category === "movies" ? "movie" : "show"]);
    const id = positiveId(record(media.ids).simkl);
    if (
      !id ||
      !STATUSES.includes(e.status as Status) ||
      (category === "movies" && ["watching", "hold"].includes(String(e.status)))
    )
      continue;
    items.set(id, {
      category,
      id,
      status: e.status as Status,
      title: typeof media.title === "string" ? media.title : "",
    });
  }
  return [...items.values()].sort((a, b) => a.id - b.id);
}
export function selectEvents(
  rows: ScheduleRow[],
  items: WatchItem[],
  preferences: Preferences,
  feed: FeedCategory,
): CalendarEvent[] {
  const watched = new Map(
    items
      .filter(
        (i) =>
          preferences.categories.includes(i.category) &&
          preferences.statuses.includes(i.status),
      )
      .map((i) => [`${i.category}:${i.id}`, i]),
  );
  const chosen = new Map<string, ScheduleRow>();
  for (const row of rows) {
    if (feed !== "all" && row.category !== feed) continue;
    if (
      !watched.has(`${row.category}:${row.id}`) ||
      !validDate(row.date) ||
      !positiveId(row.id)
    )
      continue;
    const release =
      row.category === "movies" ||
      (row.category === "anime" && row.animeMovie && !row.episode);
    if (!release && !positiveId(row.episode)) continue;
    const uid = `${row.category}-${row.id}-${release ? "release" : `${row.season ?? "none"}-${row.episode}`}@simkl-calendar`;
    const previous = chosen.get(uid);
    if (
      !previous ||
      row.date > previous.date ||
      (row.date === previous.date &&
        JSON.stringify(row) > JSON.stringify(previous))
    )
      chosen.set(uid, row);
  }
  return [...chosen]
    .map(([uid, row]) => {
      const allDay = row.date.length === 10;
      const title =
        row.title ||
        watched.get(`${row.category}:${row.id}`)?.title ||
        `Simkl ${row.id}`;
      const label = row.episode
        ? `${row.season !== undefined ? `S${row.season} ` : ""}E${row.episode}`
        : "Release";
      const badges = [
        row.episode === 1 ? "Premiere" : "",
        row.finale
          ? ["", "Mid-season finale", "Season finale", "Series finale"][
              row.finale
            ]
          : "",
      ].filter(Boolean);
      let end: string | undefined;
      if (allDay)
        end = new Date(Date.parse(row.date) + 86400000)
          .toISOString()
          .slice(0, 10);
      else if (
        row.runtimeMinutes &&
        row.runtimeMinutes > 0 &&
        row.runtimeMinutes <= 1440
      )
        end = new Date(Date.parse(row.date) + row.runtimeMinutes * 60000)
          .toISOString()
          .replace(".000", "");
      return {
        uid,
        start: row.date,
        end,
        allDay,
        summary: `${title} — ${label}`,
        description: [row.episodeTitle, ...badges, "Source: Simkl"]
          .filter(Boolean)
          .join("\n"),
        url: safeLink(row.url, row.category, row.id),
      };
    })
    .sort(
      (a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid),
    );
}
