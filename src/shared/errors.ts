export class BrawlError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BrawlError";
    this.statusCode = statusCode;
  }
}
