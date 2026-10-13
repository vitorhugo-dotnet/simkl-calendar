import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { validateEnv } from "../env";
import type { Env } from "../env";
export type App = Hono<{ Bindings: Env }>;
export type AppContext = Context<{ Bindings: Env }>;
export function coordinator(env: Env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("global"));
}
export function sessionAccount(c: AppContext) {
  const cookie = getCookie(c, "sc_session") ?? "";
  const match = /^([\w-]{43})\.([\w-]{43})$/.exec(cookie);
  if (!match) return null;
  return {
    address: match[1],
    session: match[2],
    stub: c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(match[1])),
  };
}
export function cookie(
  c: AppContext,
  name: string,
  value: string,
  maxAge: number,
) {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: validateEnv(c.env).origin.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}
export async function readForm(c: AppContext): Promise<URLSearchParams | null> {
  if (
    !(c.req.header("Content-Type") ?? "").startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    return null;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return new URLSearchParams();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(text);
}
