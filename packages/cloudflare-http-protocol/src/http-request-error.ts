export class HttpRequestError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.name = "HttpRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
