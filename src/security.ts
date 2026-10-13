import { keyBytes } from "./env";
const encode = (bytes: Uint8Array<ArrayBuffer>) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
export function randomSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hashSecret(value: string): Promise<string> {
  return encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export const pkce = hashSecret;
export async function accountAddress(
  identity: string,
  key: string,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    keyBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(identity)),
    ),
  );
}
async function aes(key: string) {
  return crypto.subtle.importKey("raw", keyBytes(key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  value: unknown,
  key: string,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await aes(key),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const bytes = new Uint8Array(12 + cipher.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(cipher), 12);
  return encode(bytes);
}
export async function open<T>(
  value: string,
  key: string,
  context: string,
): Promise<T> {
  const bytes = decode(value);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(context),
    },
    await aes(key),
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
