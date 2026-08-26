export class TransportError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'TransportError';
    this.exitCode = exitCode;
  }
}

export class ChromeUnavailableError extends TransportError {
  constructor(message) {
    super(message, 2);
    this.name = 'ChromeUnavailableError';
  }
}

export class LoginRequiredError extends TransportError {
  constructor(message) {
    super(message, 3);
    this.name = 'LoginRequiredError';
  }
}

export class SelectorMismatchError extends TransportError {
  constructor(message) {
    super(message, 4);
    this.name = 'SelectorMismatchError';
  }
}

export class ResponseTimeoutError extends TransportError {
  constructor(message) {
    super(message, 5);
    this.name = 'ResponseTimeoutError';
  }
}

export class ResponseExtractionError extends TransportError {
  constructor(message) {
    super(message, 6);
    this.name = 'ResponseExtractionError';
  }
}

export class RequestTimeoutError extends TransportError {
  constructor(message) {
    super(message, 7);
    this.name = 'RequestTimeoutError';
  }
}

export class SendFailedError extends TransportError {
  constructor(message) {
    super(message, 8);
    this.name = 'SendFailedError';
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 64;
  }
}

export function mapErrorToExitCode(err) {
  if (err && typeof err.exitCode === 'number') {
    return err.exitCode;
  }
  return 1;
}
