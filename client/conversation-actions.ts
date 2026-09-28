/** Keep presence notices and ordinary sends in gesture order, including while
 * an earlier send is waiting for its receipt. A rejected action cannot jam it. */
export class ConversationActions {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
}
