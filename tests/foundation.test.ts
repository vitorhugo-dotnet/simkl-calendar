import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { validateEnv } from "../src/env";
import { Serial } from "../src/serial";
import { env } from "cloudflare:test";
describe("foundation", () => {
  it("health discloses no configuration", async () => {
    const r = await SELF.fetch("https://example.com/health");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });
  it("validates canonical origins and secrets", () => {
    expect(
      validateEnv({ ...env, APP_ORIGIN: "https://calendar.example" }).origin,
    ).toBe("https://calendar.example");
    expect(() =>
      validateEnv({ ...env, APP_ORIGIN: "http://evil.example" }),
    ).toThrow();
    expect(() => validateEnv({ ...env, TOKEN_ENCRYPTION_KEY: "" })).toThrow();
  });
  it("serializes asynchronous operations even after failure", async () => {
    const serial = new Serial();
    const order: string[] = [];
    await Promise.all([
      serial.run(async () => {
        order.push("a");
        await Promise.resolve();
        order.push("b");
      }),
      serial.run(async () => {
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
    await expect(
      serial.run(async () => {
        throw Error("failure");
      }),
    ).rejects.toThrow();
    expect(await serial.run(async () => 42)).toBe(42);
  });
});
