import {
  ComputerAgentDispatchStatusSchema,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchStatus,
} from "@eliotr/contracts";
import {
  decodeComputerAgentDispatchAbandonment,
  decodeComputerAgentDispatchAcceptance,
  decodeComputerAgentDispatchDecline,
  decodeComputerAgentDispatchReassignment,
  readComputerAgentDispatchAbandonmentRow,
  readComputerAgentDispatchAcceptanceRow,
  readComputerAgentDispatchDeclineRow,
  readComputerAgentDispatchReassignmentRow,
  readCurrentComputerAgentDispatchOffer,
} from "./computer-agent-dispatch-record.js";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";

export async function readComputerAgentDispatchStatus(input: {
  readonly database: D1Database;
  readonly dispatch: ComputerAgentDispatch;
  readonly now: number;
}): Promise<ComputerAgentDispatchStatus> {
  const [acceptedRow, abandonedRow, declinedRow, reassignmentRow] = await Promise.all([
    readComputerAgentDispatchAcceptanceRow(input.database, input.dispatch.dispatch_id),
    readComputerAgentDispatchAbandonmentRow(input.database, input.dispatch.dispatch_id),
    readComputerAgentDispatchDeclineRow(input.database, input.dispatch.dispatch_id),
    readComputerAgentDispatchReassignmentRow(input.database, input.dispatch.dispatch_id),
  ]);
  const acceptance = acceptedRow === null ? null
    : await decodeComputerAgentDispatchAcceptance(acceptedRow);
  const abandonment = abandonedRow === null ? null
    : await decodeComputerAgentDispatchAbandonment(abandonedRow);
  const decline = declinedRow === null ? null
    : await decodeComputerAgentDispatchDecline(declinedRow);
  const reassignment = reassignmentRow === null ? null
    : await decodeComputerAgentDispatchReassignment(reassignmentRow);
  const terminalCount = Number(acceptance !== null) +
    Number(abandonment !== null) + Number(decline !== null);
  if (terminalCount > 1) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch has conflicting terminal receipts");
  }
  const state = acceptance !== null ? "ACCEPTED" as const
    : abandonment !== null ? "ABANDONED" as const
      : decline !== null ? "DECLINED" as const
        : Date.parse(input.dispatch.expires_at) <= input.now ? "EXPIRED" as const
          : await readCurrentComputerAgentDispatchOffer(
              input.database, input.dispatch.dispatch_id,
            ) === null ? "STALE" as const : "PENDING" as const;
  return ComputerAgentDispatchStatusSchema.parse({
    protocol: "eliotr.computer-agent-dispatch-status.v2",
    state,
    dispatch: input.dispatch,
    acceptance,
    abandonment,
    decline,
    reassignment,
  });
}
