import { getCookie } from "hono/cookie";
import type { App } from "./common";
import { coordinator, cookie } from "./common";
import { validateEnv } from "../env";
import { randomSecret, hashSecret, pkce, accountAddress } from "../security";
import { SimklClient } from "../simkl";
export function registerAuth(app: App): void {
  app.get("/auth/login", async (c) => {
    const config = validateEnv(c.env);
    const state = randomSecret(),
      binding = randomSecret(),
      verifier = randomSecret();
    const redirectUri = config.origin + "/auth/callback";
    await coordinator(c.env).createOAuth(state, {
      verifier,
      bindingHash: await hashSecret(binding),
      expiresAt: Date.now() + 600000,
      redirectUri,
    });
    cookie(c, "sc_oauth", binding, 600);
    const url = new URL("https://simkl.com/oauth2/authorize");
    for (const [k, v] of Object.entries({
      client_id: c.env.SIMKL_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "media:read",
      state,
      code_challenge: await pkce(verifier),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(k, v);
    return c.redirect(url.href);
  });
  app.get("/auth/callback", async (c) => {
    const config = validateEnv(c.env);
    const q = new URL(c.req.url).searchParams;
    const code = q.get("code");
    const state = q.get("state") ?? "",
      binding = getCookie(c, "sc_oauth") ?? "";
    if (
      ["state", "iss", "code", "error"].some((k) => q.getAll(k).length > 1) ||
      q.get("iss") !== "https://simkl.com" ||
      !/^[\w-]{43}$/.test(state) ||
      !/^[\w-]{43}$/.test(binding)
    )
      return c.text("Invalid sign-in response. Connect again.", 400);
    const transaction = await coordinator(c.env).consumeOAuth(
      state,
      await hashSecret(binding),
    );
    cookie(c, "sc_oauth", "", 0);
    if (
      !transaction ||
      q.has("error") ||
      !code ||
      code.length > 2048 ||
      transaction.redirectUri !== config.origin + "/auth/callback"
    )
      return c.text("Invalid sign-in response. Connect again.", 400);
    try {
      const client = new SimklClient((r) => coordinator(c.env).dispatch(r));
      const grant = await client.exchange(
        code,
        transaction.verifier,
        transaction.redirectUri,
      );
      const identity = await client.identity(grant);
      const address = await accountAddress(identity, c.env.ACCOUNT_LOOKUP_KEY);
      const { session } = await c.env.ACCOUNT.get(
        c.env.ACCOUNT.idFromName(address),
      ).attach(identity, grant);
      cookie(c, "sc_session", `${address}.${session}`, 30 * 86400);
      return c.redirect(config.origin + "/account");
    } catch {
      return c.text(
        "Simkl sign-in could not be completed. Connect again.",
        502,
      );
    }
  });
}
