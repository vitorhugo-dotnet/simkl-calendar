import type { App } from "./common";
import type { FeedCategory } from "../domain";
export function registerFeeds(app: App): void {
  app.get("/feeds/:account/:secret/:file", async (c) => {
    const address = c.req.param("account"),
      secret = c.req.param("secret"),
      file = c.req.param("file");
    const match = /^(all|tv|anime|movies)\.ics$/.exec(file);
    if (!/^[\w-]{43}$/.test(address) || !/^[\w-]{43}$/.test(secret) || !match)
      return c.text("Not found", 404);
    const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(address));
    const category = match[1] as FeedCategory;
    if (!(await account.authorizeFeed(secret, category)))
      return c.text("Not found", 404);
    try {
      const feed = await account.feed(secret, category);
      if (!feed) return c.text("Not found", 404);
      return c.body(feed.body, 200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="simkl-${category}.ics"`,
        "Cache-Control": "private, no-store",
      });
    } catch {
      return c.text("Calendar temporarily unavailable. Try again later.", 503, {
        "Retry-After": "60",
      });
    }
  });
}
