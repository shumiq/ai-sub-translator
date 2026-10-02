export class ProhibitedContentError extends Error {
  constructor(message = "Request was blocked by content filters") {
    super(message);
    this.name = "ProhibitedContentError";
  }
}

export class HighDemandError extends Error {
  constructor(message = "Model is at capacity and every API key is exhausted") {
    super(message);
    this.name = "HighDemandError";
  }
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}
