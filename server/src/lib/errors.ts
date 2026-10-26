export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

export const badRequest = (message: string, code = 'invalid_request') =>
  new ApiError(400, code, message)
export const unauthorized = (message = 'Missing or invalid token') =>
  new ApiError(401, 'unauthorized', message)
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)
export const tooManyRequests = (retryAfterMs: number) =>
  new ApiError(429, 'rate_limited', 'Too many requests, slow down.', retryAfterMs)
