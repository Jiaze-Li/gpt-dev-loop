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

export class RateLimitedError extends TransportError {
  constructor(message) {
    super(message, 9);
    this.name = 'RateLimitedError';
  }
}

export class CleanupFailedError extends TransportError {
  constructor(message) {
    super(message, 10);
    this.name = 'CleanupFailedError';
  }
}

export class ConversationIdentityError extends TransportError {
  constructor(message) {
    super(message, 11);
    this.name = 'ConversationIdentityError';
  }
}

// Thrown by SupervisorSession.ask()/close() when the Chrome tab a
// Supervisor conversation was created in no longer exists (the user closed
// it) — deliberately not auto-recovered; the caller must decide whether to
// give up or create a new SupervisorSession.
export class SupervisorTabLostError extends TransportError {
  constructor(message) {
    super(message, 12);
    this.name = 'SupervisorTabLostError';
  }
}

// Thrown by SupervisorSession.ask() when the conversation actually loaded
// in the Supervisor's tab no longer matches the id captured at creation (or
// the previous ask()) — e.g. the user manually navigated the tab to a
// different conversation. Never silently continues in the new one.
export class SupervisorIdentityMismatchError extends TransportError {
  constructor(message) {
    super(message, 13);
    this.name = 'SupervisorIdentityMismatchError';
  }
}

// Thrown by ReviewerSession.review()/close() when the caller passes a
// taskId different from the one this session was create()'d for. A
// ReviewerSession is bound to exactly one task for its whole lifetime — see
// reviewerSession.js's doc comment for why (reusing it across tasks would
// let one task's review history leak into another's verdict).
export class ReviewerTaskMismatchError extends TransportError {
  constructor(message) {
    super(message, 14);
    this.name = 'ReviewerTaskMismatchError';
  }
}

// Thrown by ReviewerSession.review()/close() when the Chrome tab a Reviewer
// conversation was created in no longer exists (the user closed it) —
// mirrors SupervisorTabLostError; deliberately not auto-recovered, and never
// falls back to picking a different ChatGPT tab.
export class ReviewerTabLostError extends TransportError {
  constructor(message) {
    super(message, 15);
    this.name = 'ReviewerTabLostError';
  }
}

// Thrown by ReviewerSession.review() when the conversation actually loaded
// in the Reviewer's tab no longer matches the id captured at the task's
// first review() call — mirrors SupervisorIdentityMismatchError; never
// silently continues in a different conversation.
export class ReviewerIdentityMismatchError extends TransportError {
  constructor(message) {
    super(message, 16);
    this.name = 'ReviewerIdentityMismatchError';
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
