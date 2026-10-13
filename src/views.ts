import { CATEGORIES, STATUSES } from "./domain";
import type { AccountView } from "./domain";
const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}<footer><p>Calendar data from <a href="https://simkl.com" rel="noreferrer">Simkl</a>.</p></footer></main></body></html>`;
}
export function home(): string {
  return page(
    "Simkl Calendar Sync",
    '<p>Subscribe to upcoming TV episodes, anime, and movie releases from your Simkl watchlist.</p><p><a href="/auth/login">Connect Simkl</a></p>',
  );
}
export function accountPage(
  view: AccountView,
  origin: string,
  address: string,
): string {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">`;
  const action = (path: string, label: string) =>
    `<form method="post" action="${path}">${csrf}<button type="submit">${label}</button></form>`;
  const labels: Record<string, string> = {
    tv: "TV",
    anime: "Anime",
    movies: "Movies",
    watching: "Watching",
    plantowatch: "Plan to watch",
    hold: "On hold",
    completed: "Completed",
    dropped: "Dropped",
  };
  let body = `<p>${view.connected ? "Simkl connected." : "Reconnect Simkl to restore access."}</p><p><a href="/auth/login">Reconnect Simkl</a></p>`;
  if (view.degraded)
    body +=
      "<p>Simkl is temporarily unavailable. Your last available watchlist may be used for up to 24 hours.</p>";
  body += `<form method="post" action="/account/preferences">${csrf}<fieldset><legend>Categories</legend>${CATEGORIES.map((c) => `<label><input type="checkbox" name="category" value="${c}"${view.preferences.categories.includes(c) ? " checked" : ""}>${labels[c]}</label>`).join("")}</fieldset><fieldset><legend>Watchlist statuses</legend>${STATUSES.map((s) => `<label><input type="checkbox" name="status" value="${s}"${view.preferences.statuses.includes(s) ? " checked" : ""}>${labels[s]}</label>`).join("")}</fieldset><p>Movies use Plan to watch, Completed, or Dropped.</p><button type="submit">Save preferences</button></form><h2>Subscription URLs</h2><p>Anyone with these URLs can read your calendar. Keep them private. Rotate or revoke them if shared accidentally; calendar apps may retain downloaded events.</p>`;
  if (view.secret) {
    for (const category of ["all", ...CATEGORIES]) {
      const url = `${origin}/feeds/${address}/${view.secret}/${category}.ics`;
      body += `<p><label>${category === "all" ? "Combined" : labels[category]}<input type="url" readonly size="100" value="${escapeHtml(url)}"></label></p>`;
    }
  } else
    body += "<p>No active subscription links. Generate new links below.</p>";
  body +=
    "<p>In Google Calendar, choose Other calendars → From URL and paste a subscription URL. Refresh timing is controlled by your calendar app.</p>";
  body +=
    action(
      "/account/rotate",
      view.secret ? "Rotate subscription URLs" : "Generate subscription URLs",
    ) +
    action("/account/revoke", "Revoke subscription URLs") +
    action("/account/refresh", "Check for watchlist updates");
  body += `<p>${view.validatedAt ? `Last watchlist check: ${escapeHtml(new Date(view.validatedAt).toISOString())}` : "Watchlist is refreshed when needed."} Updates are checked at most every 30 minutes.</p>`;
  body +=
    action("/auth/logout", "Sign out") +
    action("/account/disconnect", "Disconnect and delete account data");
  body +=
    "<p>If disconnection cannot reach Simkl, revoke this app from Simkl Connected Apps to end its access there.</p>";
  return page("Your calendar", body);
}
