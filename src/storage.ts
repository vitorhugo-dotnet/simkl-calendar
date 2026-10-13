interface Manifest {
  generation: string;
  count: number;
}
export class ChunkStore {
  constructor(private storage: DurableObjectStorage) {}
  async read<T>(key: string): Promise<T | null> {
    const manifest = await this.storage.get<Manifest>(`${key}:manifest`);
    if (!manifest) return null;
    const keys = Array.from(
      { length: manifest.count },
      (_, i) => `${key}:${manifest.generation}:${i}`,
    );
    const parts = await this.storage.get<ArrayBuffer>(keys);
    const bytes = new Uint8Array(
      keys.reduce((n, k) => n + (parts.get(k)?.byteLength ?? 0), 0),
    );
    let offset = 0;
    for (const k of keys) {
      const part = parts.get(k);
      if (!part) throw Error("Incomplete stored record");
      bytes.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  async write<T>(key: string, value: T): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const generation = crypto.randomUUID();
    const count = Math.ceil(bytes.length / 60000);
    await this.storage.transaction(async (txn) => {
      const old = await txn.get<Manifest>(`${key}:manifest`);
      for (let i = 0; i < count; i++)
        await txn.put(
          `${key}:${generation}:${i}`,
          bytes.slice(i * 60000, (i + 1) * 60000).buffer,
        );
      await txn.put(`${key}:manifest`, { generation, count });
      if (old)
        for (let i = 0; i < old.count; i++)
          await txn.delete(`${key}:${old.generation}:${i}`);
    });
  }
  async remove(key: string): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const old = await txn.get<Manifest>(`${key}:manifest`);
      if (old)
        for (let i = 0; i < old.count; i++)
          await txn.delete(`${key}:${old.generation}:${i}`);
      await txn.delete(`${key}:manifest`);
    });
  }
}
