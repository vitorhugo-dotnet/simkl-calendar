import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { HOUR, DAY } from "./domain";
import type {
  OAuthTransaction,
  Dataset,
  Category,
  DispatchRequest,
  DispatchResult,
  JsonValue,
} from "./domain";
import { Serial } from "./serial";
import { ChunkStore } from "./storage";
import { hashSecret, seal, open } from "./security";
import { normalizeDataset } from "./calendar";
import { identifiedUrl, classifyFailure } from "./simkl";
interface CachedDataset extends Dataset {
  freshUntil: number;
  etag?: string;
  lastModified?: string;
  retryAt?: number;
}
interface StoredTransaction {
  cipher: string;
  expiresAt: number;
}
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export class Coordinator extends DurableObject<Env> {
  private oauthSerial = new Serial();
  private apiSerial = new Serial();
  private categories = new Map<Category, Promise<Dataset>>();
  private store = new ChunkStore(this.ctx.storage);
  async createOAuth(
    state: string,
    transaction: OAuthTransaction,
  ): Promise<void> {
    return this.oauthSerial.run(async () => {
      for (const [key, value] of await this.ctx.storage.list<StoredTransaction>(
        { prefix: "oauth:" },
      )) {
        if (value.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
      }
      const key = `oauth:${await hashSecret(state)}`;
      await this.ctx.storage.put(key, {
        cipher: await seal(transaction, this.env.TOKEN_ENCRYPTION_KEY, key),
        expiresAt: transaction.expiresAt,
      });
    });
  }
  async consumeOAuth(
    state: string,
    bindingHash: string,
  ): Promise<OAuthTransaction | null> {
    return this.oauthSerial.run(async () => {
      const key = `oauth:${await hashSecret(state)}`;
      const value = await this.ctx.storage.get<StoredTransaction>(key);
      if (!value) return null;
      if (value.expiresAt <= Date.now()) {
        await this.ctx.storage.delete(key);
        return null;
      }
      const transaction = await open<OAuthTransaction>(
        value.cipher,
        this.env.TOKEN_ENCRYPTION_KEY,
        key,
      );
      if (transaction.bindingHash !== bindingHash) return null;
      await this.ctx.storage.delete(key);
      return transaction;
    });
  }
  async dataset(category: Category): Promise<Dataset> {
    if (!["tv", "anime", "movies"].includes(category))
      throw Error("Invalid category");
    const existing = this.categories.get(category);
    if (existing) return await existing;
    const promise = this.loadDataset(category);
    this.categories.set(category, promise);
    try {
      return await promise;
    } finally {
      this.categories.delete(category);
    }
  }
  private async loadDataset(category: Category): Promise<Dataset> {
    const key = `dataset:${category}`;
    const cached = await this.store.read<CachedDataset>(key);
    const now = Date.now();
    const failureUntil = await this.ctx.storage.get<number>(
      `failure:${category}`,
    );
    if (failureUntil && failureUntil > now) {
      if (cached && now - cached.validatedAt <= DAY) return cached;
      throw Error("Calendar dataset unavailable");
    }
    if (cached && cached.freshUntil > now) return cached;
    if (cached?.retryAt && cached.retryAt > now) {
      if (now - cached.validatedAt <= DAY) return cached;
      throw Error("Calendar dataset unavailable");
    }
    try {
      const headers = new Headers({
        "User-Agent": `${this.env.APP_NAME}/${this.env.APP_VERSION}`,
      });
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      if (cached?.lastModified)
        headers.set("If-Modified-Since", cached.lastModified);
      const filename = category === "movies" ? "movie_release" : category;
      const url = identifiedUrl(
        `https://data.simkl.in/calendar/v2/${filename}.json`,
        this.env,
      );
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 304)
        throw Error("Calendar dataset unavailable");
      const validatedAt = Date.now();
      const maxAge = /max-age=(\d+)/i.exec(
        response.headers.get("cache-control") ?? "",
      );
      const age = Number(response.headers.get("age") ?? 0);
      const ttl = Math.max(
        0,
        Math.min(5 * HOUR, maxAge ? Number(maxAge[1]) * 1000 : 5 * HOUR) -
          (Number.isFinite(age) ? age * 1000 : 0),
      );
      let value: CachedDataset;
      if (response.status === 304) {
        if (!cached) throw Error("Unexpected conditional response");
        value = {
          ...cached,
          validatedAt,
          freshUntil: validatedAt + ttl,
          retryAt: undefined,
        };
      } else {
        const raw = await readBounded(response, 10 * 1024 * 1024);
        const lastModified = response.headers.get("last-modified");
        value = {
          rows: normalizeDataset(category, raw),
          validatedAt,
          modifiedAt:
            lastModified && Number.isFinite(Date.parse(lastModified))
              ? Date.parse(lastModified)
              : validatedAt,
          freshUntil: validatedAt + ttl,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: lastModified ?? undefined,
        };
      }
      await this.store.write(key, value);
      await this.ctx.storage.delete(`failure:${category}`);
      return value;
    } catch {
      await this.ctx.storage.put(`failure:${category}`, Date.now() + 60000);
      if (cached) {
        await this.store.write(key, { ...cached, retryAt: Date.now() + 60000 });
        if (Date.now() - cached.validatedAt <= DAY) return cached;
      }
      throw Error("Calendar dataset unavailable");
    }
  }
  async dispatch(request: DispatchRequest): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }> {
    const r = await this.dispatchInternal(request);
    return { ...r, body: JSON.stringify(r.body) };
  }
  private async dispatchInternal(
    request: DispatchRequest,
  ): Promise<DispatchResult> {
    return this.apiSerial.run<DispatchResult>(async () => {
      const validGet = [
        "/users/settings",
        "/sync/activities",
        "/sync/all-items/shows",
        "/sync/all-items/anime",
        "/sync/all-items/movies",
      ];
      const validPost = ["/oauth2/token", "/oauth2/revoke"];
      if (
        !(request.method === "GET" ? validGet : validPost).includes(
          request.path,
        )
      )
        throw Error("Invalid API request");
      if (request.method === "GET" && !request.token)
        throw Error("Missing authentication");
      const tokenKey = request.token
        ? `backoff:${await hashSecret(request.token)}`
        : null;
      if (tokenKey) {
        const retryAt = await this.ctx.storage.get<number>(tokenKey);
        if (retryAt && retryAt > Date.now())
          return {
            status: 429,
            body: { error: "user_limit_exceeded" },
            headers: {
              "retry-after": String(Math.ceil((retryAt - Date.now()) / 1000)),
            },
          };
      }
      const url = identifiedUrl(
        `https://api.simkl.com${request.path}`,
        this.env,
      );
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (!["date_from", "extended"].includes(key))
          throw Error("Invalid API query");
        url.searchParams.set(key, value);
      }
      const headers = new Headers({
        "User-Agent": `${this.env.APP_NAME}/${this.env.APP_VERSION}`,
      });
      if (request.token)
        headers.set("Authorization", `Bearer ${request.token}`);
      let body: URLSearchParams | undefined;
      if (request.method === "POST") {
        body = new URLSearchParams(request.form);
        body.set("client_id", this.env.SIMKL_CLIENT_ID);
        body.set("client_secret", this.env.SIMKL_CLIENT_SECRET);
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const pacingKey = `pace:${request.method}`;
        const next = (await this.ctx.storage.get<number>(pacingKey)) ?? 0;
        await wait(Math.max(0, next - Date.now()));
        await this.ctx.storage.put(
          pacingKey,
          Date.now() + (request.method === "GET" ? 110 : 1100),
        );
        let result: DispatchResult;
        try {
          const response = await fetch(url, {
            method: request.method,
            headers,
            body,
            signal: AbortSignal.timeout(15000),
          });
          const json = await readBounded(response, 20 * 1024 * 1024);
          result = {
            status: response.status,
            body: json,
            headers: Object.fromEntries(
              ["retry-after", "x-ratelimit-remaining"].flatMap((key) =>
                response.headers.has(key)
                  ? [[key, response.headers.get(key) ?? ""]]
                  : [],
              ),
            ),
          };
        } catch {
          result = { status: 503, body: { error: "unavailable" }, headers: {} };
        }
        if (result.status < 400) return result;
        const failure = classifyFailure(result, Date.now());
        if (tokenKey && ["quota", "burst"].includes(failure.kind))
          await this.ctx.storage.put(tokenKey, failure.retryAt);
        if (
          request.method === "GET" &&
          attempt === 0 &&
          ["burst", "transient"].includes(failure.kind)
        ) {
          await wait(failure.kind === "burst" ? 1000 : 250);
          continue;
        }
        return result;
      }
      return { status: 503, body: {}, headers: {} };
    });
  }
}
export async function readBounded(
  response: Response,
  limit: number,
): Promise<JsonValue> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw Error("Upstream response too large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) return {};
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
