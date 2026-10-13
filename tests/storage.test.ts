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
