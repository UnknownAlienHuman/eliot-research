import {
  ComputerAgentDispatchListSchema,
  ComputerAgentDispatchSummarySchema,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchList,
  type ComputerAgentDispatchStatus,
} from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  ComputerAgentDispatchError,
  failComputerAgentDispatch as fail,
} from "./computer-agent-dispatch-error.js";
import {
  decodeComputerAgentDispatch,
  readComputerAgentDispatchRow,
  type DispatchRow,
} from "./computer-agent-dispatch-record.js";
import { readComputerAgentDispatchStatus } from "./computer-agent-dispatch-status.js";

export const COMPUTER_AGENT_DISPATCH_PAGE_SIZE = 20;
const QUERY_LIMIT = COMPUTER_AGENT_DISPATCH_PAGE_SIZE + 1;

function requireTerminalBindings(status: ComputerAgentDispatchStatus): void {
  const dispatch = status.dispatch;
  const accepted = status.acceptance;
  if (accepted !== null && (accepted.connection_id !== dispatch.connection_id ||
      accepted.connection_revision !== dispatch.connection_revision ||
      accepted.client_grant_id !== dispatch.client_grant_id ||
      accepted.client_grant_revision !== dispatch.client_grant_revision ||
      canonicalJson(accepted.actor) !== canonicalJson(dispatch.actor) ||
      accepted.credential_generation !== dispatch.qualification.verified_credential_generation)) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch acceptance is bound to another target");
  }
  if (status.abandonment !== null &&
      status.abandonment.owner_principal_ref !== dispatch.owner_principal_ref) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch abandonment is bound to another owner");
  }
  if (status.decline !== null &&
      status.decline.credential_generation !== dispatch.qualification.verified_credential_generation) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch decline is bound to another credential generation");
  }
  if (status.reassignment !== null &&
      status.reassignment.owner_principal_ref !== dispatch.owner_principal_ref) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch reassignment is bound to another owner");
  }
}

function summarize(dispatch: ComputerAgentDispatch, status: ComputerAgentDispatchStatus) {
  requireTerminalBindings(status);
  return ComputerAgentDispatchSummarySchema.parse({
    protocol: "eliotr.computer-agent-dispatch-summary.v1",
    dispatch_id: dispatch.dispatch_id,
    project_id: dispatch.project_id,
    connection_id: dispatch.connection_id,
    connection_revision: dispatch.connection_revision,
    state: status.state,
    created_at: dispatch.created_at,
    expires_at: dispatch.expires_at,
    question: dispatch.run_request.query,
    accepted_workflow: status.acceptance === null ? null : {
      workflow_instance_id: status.acceptance.workflow_instance_id,
      investigation_ref: status.acceptance.investigation_ref,
    },
  });
}

async function readCursor(input: {
  readonly database: D1Database;
  readonly project_id: string;
  readonly owner_principal_ref: string;
  readonly after_dispatch_id: string;
}): Promise<void> {
  const row = await readComputerAgentDispatchRow(input.database, input.after_dispatch_id);
  if (row === null) fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
    "Dispatch cursor is not in this project");
  const dispatch = await decodeComputerAgentDispatch(row);
  if (dispatch.dispatch_id !== input.after_dispatch_id ||
      dispatch.project_id !== input.project_id ||
      dispatch.owner_principal_ref !== input.owner_principal_ref) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch cursor is not in this project");
  }
}

async function readRows(input: {
  readonly database: D1Database;
  readonly project_id: string;
  readonly after_dispatch_id?: string | undefined;
}): Promise<DispatchRow[]> {
  try {
    const statement = input.after_dispatch_id === undefined
      ? input.database.prepare("SELECT * FROM computer_agent_dispatch " +
        "WHERE project_id=?1 ORDER BY dispatch_id ASC LIMIT 21").bind(input.project_id)
      : input.database.prepare("SELECT * FROM computer_agent_dispatch " +
        "WHERE project_id=?1 AND dispatch_id>?2 ORDER BY dispatch_id ASC LIMIT 21")
        .bind(input.project_id, input.after_dispatch_id);
    const result = await statement.all<DispatchRow>();
    const rows = result.results ?? [];
    if (rows.length > QUERY_LIMIT) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch page exceeded its read bound");
    return rows;
  } catch (error) {
    if (error instanceof ComputerAgentDispatchError) throw error;
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch listing is unavailable", true);
  }
}

export async function readComputerAgentDispatchPage(input: {
  readonly database: D1Database;
  readonly project_id: string;
  readonly owner_principal_ref: string;
  readonly after_dispatch_id?: string | undefined;
  readonly now: number;
}): Promise<ComputerAgentDispatchList> {
  if (input.after_dispatch_id !== undefined) {
    await readCursor({
      database: input.database,
      project_id: input.project_id,
      owner_principal_ref: input.owner_principal_ref,
      after_dispatch_id: input.after_dispatch_id,
    });
  }
  const rows = await readRows(input);
  const dispatches = await Promise.all(rows.map((row) => decodeComputerAgentDispatch(row)));
  let previousId: string | undefined;
  for (const dispatch of dispatches) {
    if (dispatch.project_id !== input.project_id ||
        dispatch.owner_principal_ref !== input.owner_principal_ref ||
        (previousId !== undefined && dispatch.dispatch_id <= previousId) ||
        (input.after_dispatch_id !== undefined && dispatch.dispatch_id <= input.after_dispatch_id)) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Dispatch page contains a foreign or inconsistent ledger row");
    }
    previousId = dispatch.dispatch_id;
  }
  const statuses = await Promise.all(dispatches.map((dispatch) => readComputerAgentDispatchStatus({
    database: input.database,
    dispatch,
    now: input.now,
  })));
  const items = dispatches.slice(0, COMPUTER_AGENT_DISPATCH_PAGE_SIZE).map((dispatch, index) => {
    const status = statuses[index];
    if (status === undefined) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch status readback is incomplete");
    return summarize(dispatch, status);
  });
  return ComputerAgentDispatchListSchema.parse({
    protocol: "eliotr.computer-agent-dispatch-list.v1",
    items,
    next_after_dispatch_id: rows.length > COMPUTER_AGENT_DISPATCH_PAGE_SIZE
      ? items.at(-1)?.dispatch_id ?? null
      : null,
  });
}
