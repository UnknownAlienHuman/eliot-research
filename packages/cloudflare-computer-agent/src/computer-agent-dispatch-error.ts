export type ComputerAgentDispatchErrorCode =
  | "COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY"
  | "COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED"
  | "COMPUTER_AGENT_DISPATCH_SERVICE_REQUIRED"
  | "COMPUTER_AGENT_DISPATCH_INPUT_INVALID"
  | "COMPUTER_AGENT_DISPATCH_NOT_FOUND"
  | "COMPUTER_AGENT_DISPATCH_DENIED"
  | "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE"
  | "COMPUTER_AGENT_DISPATCH_EXPIRED"
  | "COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT"
  | "COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT"
  | "COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE"
  | "COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN";

export class ComputerAgentDispatchError extends Error {
  readonly code: ComputerAgentDispatchErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ComputerAgentDispatchErrorCode, status: number,
    message: string, retryable = false) {
    super(message);
    this.name = "ComputerAgentDispatchError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function failComputerAgentDispatch(code: ComputerAgentDispatchErrorCode, status: number,
  message: string, retryable = false): never {
  throw new ComputerAgentDispatchError(code, status, message, retryable);
}
