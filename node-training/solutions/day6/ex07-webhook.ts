export interface WebhookEvent {
  eventId: string;
  topupId: string;
  result: 'succeeded' | 'failed';
}

type Status = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export function createWalletState() {
  const topups = new Map<string, { amount: number; status: Status }>();
  const seenEvents = new Set<string>();

  return {
    addTopup(id: string, amount: number): void {
      topups.set(id, { amount, status: 'PENDING' });
    },
    handleWebhook(event: WebhookEvent): 'applied' | 'duplicate' | 'ignored' {
      if (seenEvents.has(event.eventId)) {
        return 'duplicate';
      }
      const topup = topups.get(event.topupId);
      if (!topup) {
        throw new Error(`unknown topup: ${event.topupId}`);
      }
      seenEvents.add(event.eventId);
      if (topup.status === 'SUCCEEDED') {
        return 'ignored';
      }
      topup.status = event.result === 'succeeded' ? 'SUCCEEDED' : 'FAILED';
      return 'applied';
    },
    statusOf(topupId: string): Status {
      const topup = topups.get(topupId);
      if (!topup) {
        throw new Error(`unknown topup: ${topupId}`);
      }
      return topup.status;
    },
    balance(): number {
      let total = 0;
      for (const topup of topups.values()) {
        if (topup.status === 'SUCCEEDED') total += topup.amount;
      }
      return total;
    },
  };
}
