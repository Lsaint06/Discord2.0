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
export const forbidden = (message = 'You can’t do that', code = 'forbidden') =>
  new ApiError(403, code, message)
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message)
export const payloadTooLarge = (message: string, code = 'too_large') =>
  new ApiError(413, code, message)
export const unsupportedType = (message: string) =>
  new ApiError(415, 'unsupported_file_type', message)
export const insufficientStorage = (message: string) =>
  new ApiError(507, 'storage_full', message)
export const tooManyRequests = (retryAfterMs: number) =>
  new ApiError(429, 'rate_limited', 'Too many requests, slow down.', retryAfterMs)
