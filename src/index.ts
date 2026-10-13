import { Hono } from "hono";
import type { Env } from "./env";
import { home } from "./views";
import { registerAuth } from "./routes/auth";
import { registerAccount } from "./routes/account";
import { registerFeeds } from "./routes/feeds";
export { Account } from "./account";
export { Coordinator } from "./coordinator";
const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  c.header("Cache-Control", "private, no-store");
  await next();
});
app.onError((_error, c) =>
  c.text("Service temporarily unavailable", 503, { "Retry-After": "60" }),
);
app.notFound((c) => c.text("Not found", 404));
app.get("/health", (c) => c.text("ok"));
app.get("/", (c) => c.html(home()));
registerAuth(app);
registerAccount(app);
registerFeeds(app);
export default app;
