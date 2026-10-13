import { CATEGORIES, STATUSES, record, positiveId } from "./domain";
import type { TokenGrant, WatchSnapshot, Category } from "./domain";
import type { SimklClient } from "./simkl";
import { normalizeWatchlist, apiCategory } from "./calendar";
const activityCategory = (category: Category) =>
  category === "tv" ? "tv_shows" : category;
function inventory(category: Category, raw: unknown): Set<number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Invalid deletion inventory");
  const values = record(raw)[apiCategory(category)];
  if (values === undefined) return new Set();
  if (!Array.isArray(values)) throw Error("Invalid deletion inventory");
  const ids = new Set<number>();
  for (const value of values) {
    const media = record(
      record(value)[category === "movies" ? "movie" : "show"],
    );
    const id = positiveId(record(media.ids).simkl);
    if (!id) throw Error("Invalid deletion inventory");
    ids.add(id);
  }
  return ids;
}
export async function syncWatchlist(
  client: SimklClient,
  grant: TokenGrant,
  previous: WatchSnapshot | null,
  now: number,
): Promise<WatchSnapshot> {
  const activities = await client.activities(grant);
  const items = new Map(
    (previous?.items ?? []).map((i) => [`${i.category}:${i.id}`, i]),
  );
  for (const category of CATEGORIES) {
    const current = activities[activityCategory(category)];
    const old = previous?.activities[activityCategory(category)];
    const membershipChanged =
      !old || STATUSES.some((s) => current[s] !== old[s]);
    if (membershipChanged) {
      const raw = await client.items(
        grant,
        category,
        previous ? { date_from: previous.activities.all } : undefined,
      );
      for (const item of normalizeWatchlist(category, raw))
        items.set(`${category}:${item.id}`, item);
    }
    if (old && current.removed_from_list !== old.removed_from_list) {
      const ids = inventory(
        category,
        await client.items(grant, category, { extended: "simkl_ids_only" }),
      );
      for (const [key, item] of items)
        if (item.category === category && !ids.has(item.id)) items.delete(key);
    }
  }
  return {
    items: [...items.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.id - b.id,
    ),
    activities,
    validatedAt: now,
  };
}
