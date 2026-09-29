// Bounded concurrency for independent Jev requests and page reads.

/** Run `fn` over `items` with at most `n` in flight, keeping order. */
export async function pool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}
