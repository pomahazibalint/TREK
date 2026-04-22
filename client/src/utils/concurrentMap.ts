export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
