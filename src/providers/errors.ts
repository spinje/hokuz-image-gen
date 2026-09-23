import { ErrorType, ToolError } from "../types.js";

type RequestFailure = {
  status?: number;
  reason?: string;
  keyRejected?: boolean;
  contentBlocked?: boolean;
  quotaExhausted?: boolean;
  cancelled?: boolean;
};

/** Normalize provider evidence once; lack of a response is not proof of rejection. */
export function providerRequestError(
  provider: string, model: string, failure: RequestFailure, cause: unknown,
): ToolError {
  const { status, reason } = failure;
  if (failure.cancelled) {
    return new ToolError(ErrorType.REQUEST_CANCELLED,
      `${provider} generation was cancelled while awaiting a response. Completion and billing could not be confirmed.`,
      "Do not automatically retry a cancelled request. Cancellation does not guarantee that generation stopped or that charges were refunded.", cause);
  }
  if (failure.keyRejected || status === 401) {
    return new ToolError(ErrorType.MISSING_API_KEY,
      `${provider} rejected the server's API key.`,
      `Have the server operator correct the ${provider} credentials. Do not put API keys in tool arguments.`, cause);
  }
  if (failure.contentBlocked) {
    return new ToolError(ErrorType.CONTENT_BLOCKED,
      `${provider} reported that content moderation blocked this request.`,
      "Revise the prompt or input images to address the content restriction before submitting a new request.", cause);
  }
  if (status === 403) {
    return new ToolError(ErrorType.API_ERROR,
      `${provider} denied access to '${model}'.`,
      `Have the server operator check the account's access to '${model}' before retrying.`, cause);
  }
  if (status === 404) {
    return new ToolError(ErrorType.API_ERROR,
      `${provider} could not find the requested model or resource for '${model}'.`,
      "Check that the model and requested options are available to the configured account. Choose a different model only if it meets the task's requirements.", cause);
  }
  if (failure.quotaExhausted) {
    return new ToolError(ErrorType.API_RATE_LIMIT,
      `${provider} reported that the account's quota is exhausted.`,
      "Have the server operator restore quota or billing capacity before submitting another request.", cause);
  }
  if (status === 429) {
    return new ToolError(ErrorType.API_RATE_LIMIT,
      `${provider} rejected this request because an account limit was reached.`,
      "Check the provider's limit or quota. Retry after capacity is available; there is no guaranteed fixed wait time.", cause);
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409) {
    // A provider's explicit rejection reason is useful. Raw transport exceptions
    // and response bodies are not recovery advice and stay in the internal cause.
    const explanation = reason?.trim();
    const detail = explanation && !/^[{[]/.test(explanation)
      ? ` ${explanation.split("\n")[0].slice(0, 500)}` : "";
    return new ToolError(ErrorType.API_ERROR,
      `${provider} rejected the request.${detail}`,
      "Correct the request using the rejection reason before submitting it again. If no correction is identified, report the problem instead of guessing different arguments.", cause);
  }
  return new ToolError(ErrorType.API_ERROR,
    `No usable result was received from ${provider} for this request. Completion and billing could not be confirmed.`,
    "Do not automatically retry. If another paid attempt is acceptable, submit a new request; the interrupted request may also incur a charge.", cause);
}
