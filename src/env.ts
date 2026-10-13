import type { Account } from "./account";
import type { Coordinator } from "./coordinator";
export interface Env {
  ACCOUNT: DurableObjectNamespace<Account>;
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  SIMKL_CLIENT_ID: string;
  SIMKL_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  ACCOUNT_LOOKUP_KEY: string;
  APP_ORIGIN: string;
  APP_NAME: string;
  APP_VERSION: string;
}
export interface Config {
  origin: string;
}
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  try {
    const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw Error();
    return bytes;
  } catch {
    throw Error("Invalid encryption configuration");
  }
}
export function validateEnv(env: Env): Config {
  const u = new URL(env.APP_ORIGIN);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw Error("Invalid application origin");
  keyBytes(env.TOKEN_ENCRYPTION_KEY);
  keyBytes(env.ACCOUNT_LOOKUP_KEY);
  if (
    !env.SIMKL_CLIENT_ID ||
    !env.SIMKL_CLIENT_SECRET ||
    !env.APP_NAME ||
    !env.APP_VERSION
  )
    throw Error("Missing application configuration");
  return {
    origin: u.origin,
  };
}
