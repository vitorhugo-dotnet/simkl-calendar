import { expect, it } from "vitest";
import {
  randomSecret,
  hashSecret,
  accountAddress,
  seal,
  open,
  pkce,
} from "../src/security";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
it("creates 256-bit secrets and deterministic HMAC addresses", async () => {
  expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomSecret()).not.toBe(randomSecret());
  expect(await accountAddress("123", key)).toBe(
    await accountAddress("123", key),
  );
  expect(await accountAddress("123", key)).not.toBe(
    await accountAddress("124", key),
  );
  expect(await hashSecret("secret")).not.toContain("secret");
});
it("implements the published S256 PKCE vector", async () => {
  expect(await pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
it("encrypts with randomized nonce and rejects tampering, keys or context", async () => {
  const value = { token: "private" };
  const encrypted = await seal(value, key, "a:tokens");
  expect(encrypted).not.toContain("private");
  expect(await open(encrypted, key, "a:tokens")).toEqual(value);
  expect(await seal(value, key, "a:tokens")).not.toBe(encrypted);
  await expect(open(encrypted, key, "b:tokens")).rejects.toThrow();
  await expect(
    open(encrypted.slice(0, -5) + "AAAAA", key, "a:tokens"),
  ).rejects.toThrow();
  await expect(
    open(encrypted, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", "a:tokens"),
  ).rejects.toThrow();
});
