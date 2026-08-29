import type { Env } from "./env.js";

export async function handleQueue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
  // Fail closed until ER-15 wires the durable D1 intent/outbox consumer. Retrying preserves the
  // message; acknowledging here would falsely report work as completed.
  for (const message of batch.messages) message.retry({ delaySeconds: 60 });
}
