export class ControlRequestError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}
