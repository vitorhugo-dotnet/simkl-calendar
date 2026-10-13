import type { App } from "./common";
import { cookie, readForm, sessionAccount } from "./common";
import { validateEnv } from "../env";
import { CATEGORIES, STATUSES } from "../domain";
import type { AccountAction, Category, Status } from "../domain";
import { accountPage } from "../views";
export function registerAccount(app: App): void {
  app.get("/account", async (c) => {
    const config = validateEnv(c.env);
    const account = sessionAccount(c);
    const view = account ? await account.stub.view(account.session) : null;
    if (!account || !view) return c.redirect(config.origin + "/");
    return c.html(
      accountPage(
        view,
        config.origin,
        account.address,
        config.subscriptionsApproved,
      ),
    );
  });
  const actions = [
    "preferences",
    "refresh",
    "rotate",
    "revoke",
    "disconnect",
  ] as const;
  const mutate = (path: string, type: AccountAction["type"]) =>
    app.post(path, async (c) => {
      const config = validateEnv(c.env);
      if (c.req.header("Origin") !== config.origin)
        return c.text("Forbidden", 403);
      const account = sessionAccount(c);
      const view = account ? await account.stub.view(account.session) : null;
      if (!account || !view) return c.text("Forbidden", 403);
      const form = await readForm(c);
      if (!form) return c.text("Invalid or oversized form", 413);
      if (form.getAll("csrf").length !== 1 || form.get("csrf") !== view.csrf)
        return c.text("Forbidden", 403);
      let action: AccountAction;
      if (type === "preferences") {
        const categories = form.getAll("category"),
          statuses = form.getAll("status");
        if (
          categories.some((v) => !CATEGORIES.includes(v as Category)) ||
          statuses.some((v) => !STATUSES.includes(v as Status))
        )
          return c.text("Invalid preferences", 400);
        action = {
          type,
          preferences: {
            categories: categories as Category[],
            statuses: statuses as Status[],
          },
        };
      } else action = { type };
      try {
        await account.stub.mutate(account.session, view.csrf, action);
      } catch {
        return c.text(
          "Account action could not be completed. Try again later.",
          503,
          { "Retry-After": "60" },
        );
      }
      if (type === "logout" || type === "disconnect") {
        cookie(c, "sc_session", "", 0);
        return c.redirect(config.origin + "/");
      }
      return c.redirect(config.origin + "/account");
    });
  for (const action of actions) mutate(`/account/${action}`, action);
  mutate("/auth/logout", "logout");
}
