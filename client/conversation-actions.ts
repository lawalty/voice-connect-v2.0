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

export const presenceNotes = {
  standby: '[Voice Connect: standby] Something came up unexpectedly, such as someone walking up or a phone call. I am stepping away and will return soon. Pause our conversation and wait for me. Do not speak, ask follow-up questions, or treat this as ending the conversation. This is a control notice from my orb tap, not a new task.',
  resume: '[Voice Connect: resumed] I am back and have tapped the orb to resume our existing conversation. Standby is over. Wait for my next message; no greeting, recap, or acknowledgement is needed. Do not restart an interrupted task unless I ask.',
} as const;
