import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CATEGORIES, STATUSES, DEFAULT_PREFERENCES, DAY } from "./domain";
import type {
  AccountView,
  AccountAction,
  TokenGrant,
  FeedCategory,
  Preferences,
  WatchSnapshot,
  Dataset,
} from "./domain";
import { Serial } from "./serial";
import { ChunkStore } from "./storage";
import {
  accountAddress,
  hashSecret,
  randomSecret,
  seal,
  open,
} from "./security";
import { SimklClient, UpstreamError } from "./simkl";
import { syncWatchlist } from "./sync";
import { selectEvents } from "./calendar";
import { serializeCalendar } from "./ical";
interface Session {
  hash: string;
  csrf: string;
  expiresAt: number;
}
interface AccountState {
  address: string;
  credentials: string | null;
  preferences: Preferences;
  secretHash: string | null;
  secretCipher: string | null;
  sessions: Session[];
  snapshot: WatchSnapshot | null;
  modifiedAt: number;
  retryAt: number;
  degraded: boolean;
}
export class Account extends DurableObject<Env> {
  private serial = new Serial();
  private store = new ChunkStore(this.ctx.storage);
  private coordinator() {
    return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("global"));
  }
  private client() {
    const coordinator = this.coordinator();
    return new SimklClient((request) => coordinator.dispatch(request));
  }
  private async saved(): Promise<AccountState | null> {
    return this.store.read<AccountState>("account");
  }
  private async session(
    state: AccountState | null,
    secret: string,
  ): Promise<Session | null> {
    if (!state || !/^[\w-]{43}$/.test(secret)) return null;
    const hash = await hashSecret(secret);
    return (
      state.sessions.find((s) => s.hash === hash && s.expiresAt > Date.now()) ??
      null
    );
  }
  private async tokens(state: AccountState): Promise<TokenGrant> {
    if (!state.credentials) throw new UpstreamError(401, "auth", 0);
    return open<TokenGrant>(
      state.credentials,
      this.env.TOKEN_ENCRYPTION_KEY,
      `${state.address}:tokens`,
    );
  }
  private async changeSecret(state: AccountState): Promise<void> {
    const secret = randomSecret();
    state.secretHash = await hashSecret(secret);
    state.secretCipher = await seal(
      secret,
      this.env.TOKEN_ENCRYPTION_KEY,
      `${state.address}:feed`,
    );
  }
  async attach(
    identity: string,
    grant: TokenGrant,
  ): Promise<{ session: string }> {
    return this.serial.run(async () => {
      const address = await accountAddress(
        identity,
        this.env.ACCOUNT_LOOKUP_KEY,
      );
      if (
        this.ctx.id.toString() !==
        this.env.ACCOUNT.idFromName(address).toString()
      )
        throw Error("Invalid account binding");
      const previous = await this.saved();
      const old = previous?.credentials ? await this.tokens(previous) : null;
      const state: AccountState = previous ?? {
        address,
        credentials: null,
        preferences: structuredClone(DEFAULT_PREFERENCES),
        secretHash: null,
        secretCipher: null,
        sessions: [],
        snapshot: null,
        modifiedAt: Date.now(),
        retryAt: 0,
        degraded: false,
      };
      state.credentials = await seal(
        grant,
        this.env.TOKEN_ENCRYPTION_KEY,
        `${address}:tokens`,
      );
      state.retryAt = 0;
      state.degraded = false;
      state.snapshot = null;
      state.modifiedAt = Date.now();
      if (!previous) await this.changeSecret(state);
      const session = randomSecret();
      state.sessions = state.sessions
        .filter((s) => s.expiresAt > Date.now())
        .slice(-9);
      state.sessions.push({
        hash: await hashSecret(session),
        csrf: randomSecret(),
        expiresAt: Date.now() + 30 * DAY,
      });
      await this.store.write("account", state);
      if (old && old.refreshToken !== grant.refreshToken)
        try {
          await this.client().revoke(old);
        } catch {}
      return { session };
    });
  }
  async view(session: string): Promise<AccountView | null> {
    return this.serial.run(async () => {
      const state = await this.saved();
      const authorized = await this.session(state, session);
      if (!state || !authorized) return null;
      return {
        preferences: state.preferences,
        csrf: authorized.csrf,
        secret: state.secretCipher
          ? await open<string>(
              state.secretCipher,
              this.env.TOKEN_ENCRYPTION_KEY,
              `${state.address}:feed`,
            )
          : null,
        validatedAt: state.snapshot?.validatedAt ?? null,
        connected: !!state.credentials,
        degraded: state.degraded,
      };
    });
  }
  async mutate(
    session: string,
    csrf: string,
    action: AccountAction,
  ): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.saved();
      const authorized = await this.session(state, session);
      if (!state || !authorized || authorized.csrf !== csrf)
        throw Error("Unauthorized account action");
      switch (action.type) {
        case "preferences": {
          const p = action.preferences;
          if (
            !Array.isArray(p.categories) ||
            !Array.isArray(p.statuses) ||
            p.categories.some((v) => !CATEGORIES.includes(v)) ||
            p.statuses.some((v) => !STATUSES.includes(v))
          )
            throw Error("Invalid preferences");
          state.preferences = {
            categories: [...new Set(p.categories)],
            statuses: [...new Set(p.statuses)],
          };
          state.modifiedAt = Date.now();
          break;
        }
        case "rotate":
          await this.changeSecret(state);
          state.modifiedAt = Date.now();
          break;
        case "revoke":
          state.secretHash = null;
          state.secretCipher = null;
          break;
        case "logout":
          state.sessions = state.sessions.filter((s) => s !== authorized);
          break;
        case "disconnect": {
          const grant = state.credentials ? await this.tokens(state) : null;
          await this.store.remove("account");
          if (grant)
            try {
              await this.client().revoke(grant);
            } catch {}
          return;
        }
        case "refresh":
          await this.ensureSnapshot(state);
          break;
        default:
          throw Error("Invalid account action");
      }
      await this.store.write("account", state);
    });
  }
  private async refreshGrant(
    state: AccountState,
    grant: TokenGrant,
  ): Promise<TokenGrant> {
    let refreshed: TokenGrant;
    try {
      refreshed = await this.client().refresh(grant);
    } catch (error) {
      if (
        error instanceof UpstreamError &&
        ["auth", "invalid"].includes(error.kind)
      )
        throw new UpstreamError(401, "auth", 0);
      throw error;
    }
    state.credentials = await seal(
      refreshed,
      this.env.TOKEN_ENCRYPTION_KEY,
      `${state.address}:tokens`,
    );
    await this.store.write("account", state);
    return refreshed;
  }
  private async ensureSnapshot(state: AccountState): Promise<WatchSnapshot> {
    const now = Date.now();
    if (state.snapshot && now - state.snapshot.validatedAt < 1800000)
      return state.snapshot;
    if (state.retryAt > now) {
      if (state.snapshot && now - state.snapshot.validatedAt <= DAY)
        return state.snapshot;
      throw new UpstreamError(503, "transient", state.retryAt);
    }
    try {
      let grant = await this.tokens(state);
      let refreshed = false;
      if (grant.expiresAt <= now + 60000) {
        grant = await this.refreshGrant(state, grant);
        refreshed = true;
      }
      let next: WatchSnapshot;
      try {
        next = await syncWatchlist(
          this.client(),
          grant,
          state.snapshot,
          Date.now(),
        );
      } catch (error) {
        if (
          error instanceof UpstreamError &&
          error.kind === "auth" &&
          !refreshed
        ) {
          grant = await this.refreshGrant(state, grant);
          next = await syncWatchlist(
            this.client(),
            grant,
            state.snapshot,
            Date.now(),
          );
        } else throw error;
      }
      if (JSON.stringify(next.items) !== JSON.stringify(state.snapshot?.items))
        state.modifiedAt = Date.now();
      state.snapshot = next;
      state.retryAt = 0;
      state.degraded = false;
      await this.store.write("account", state);
      return next;
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "auth") {
        state.credentials = null;
        state.snapshot = null;
        state.secretHash = null;
        state.secretCipher = null;
        state.degraded = true;
        await this.store.write("account", state);
        throw error;
      }
      state.retryAt =
        error instanceof UpstreamError
          ? Math.max(Date.now() + 60000, error.retryAt)
          : Date.now() + 60000;
      state.degraded = true;
      await this.store.write("account", state);
      if (state.snapshot && Date.now() - state.snapshot.validatedAt <= DAY)
        return state.snapshot;
      throw new UpstreamError(503, "transient", state.retryAt);
    }
  }
  async feed(
    secret: string,
    category: FeedCategory,
  ): Promise<{ body: string; modifiedAt: number } | null> {
    return this.serial.run(async () => {
      const state = await this.saved();
      if (
        !state?.credentials ||
        !state.secretHash ||
        !/^[\w-]{43}$/.test(secret) ||
        !["all", ...CATEGORIES].includes(category) ||
        (await hashSecret(secret)) !== state.secretHash
      )
        return null;
      const categories = state.preferences.categories.filter(
        (c) => category === "all" || c === category,
      );
      if (!categories.length || !state.preferences.statuses.length)
        return {
          body: serializeCalendar([], state.modifiedAt),
          modifiedAt: state.modifiedAt,
        };
      let snapshot: WatchSnapshot;
      try {
        snapshot = await this.ensureSnapshot(state);
      } catch (error) {
        if (error instanceof UpstreamError && error.kind === "auth")
          return null;
        throw error;
      }
      if (
        !snapshot.items.some(
          (i) =>
            categories.includes(i.category) &&
            state.preferences.statuses.includes(i.status),
        )
      )
        return {
          body: serializeCalendar([], state.modifiedAt),
          modifiedAt: state.modifiedAt,
        };
      const datasets: Dataset[] = [];
      for (const c of categories)
        datasets.push(await this.coordinator().dataset(c));
      const modifiedAt = Math.max(
        state.modifiedAt,
        ...datasets.map((d) => d.modifiedAt),
      );
      const events = selectEvents(
        datasets.flatMap((d) => d.rows),
        snapshot.items,
        state.preferences,
        category,
      );
      return { body: serializeCalendar(events, modifiedAt), modifiedAt };
    });
  }
}
