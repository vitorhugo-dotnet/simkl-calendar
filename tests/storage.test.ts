import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { ChunkStore } from "../src/storage";
it("round trips large Unicode records and removes obsolete chunks", async () => {
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("storage"));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = { text: "🎬".repeat(100000) };
    await store.write("record", value);
    expect(await store.read("record")).toEqual(value);
    await store.write("record", { text: "small" });
    expect(await store.read("record")).toEqual({ text: "small" });
    expect((await state.storage.list()).size).toBe(2);
    await store.remove("record");
    expect(await store.read("record")).toBeNull();
    expect((await state.storage.list()).size).toBe(0);
  });
});
it("reads records that span more than 128 chunks", async () => {
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    const value = { text: "x".repeat(9 * 1024 * 1024) };
    await store.write("large", value);
    expect(await store.read("large")).toEqual(value);
  });
});
it("failed publication rolls back to the previous complete manifest", async () => {
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new ChunkStore(state.storage);
    await store.write("record", { value: "before" });
    const failing = new Proxy(state.storage, {
      get(target, key) {
        if (key === "transaction")
          return (
            callback: (txn: DurableObjectTransaction) => Promise<unknown>,
          ) =>
            target.transaction(async (txn) => {
              await callback(txn);
              throw Error("publication failed");
            });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new ChunkStore(failing).write("record", { value: "after" }),
    ).rejects.toThrow("publication failed");
    expect(await store.read("record")).toEqual({ value: "before" });
  });
});
