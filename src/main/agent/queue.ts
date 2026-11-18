// One turn at a time per (conversation, bot): later requests wait in line, then run and see the
// newest messages (ARCHITECTURE §5.2 point 5).

export class SerialQueues {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  /** True while something runs or waits for this key. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }

  /** Settles once everything queued so far has run. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }
}
