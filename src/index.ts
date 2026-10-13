import { Hono } from "hono";
import type { Env } from "./env";
export { Account } from "./account";
export { Coordinator } from "./coordinator";
const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.text("ok"));
export default app;
