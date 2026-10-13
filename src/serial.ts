export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => await operation());
    this.tail = result.catch(() => {});
    return result;
  }
}
