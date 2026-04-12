/**
 * Determine if an error is a network error (vs a server error).
 * Network errors have no response object (e.g., ECONNREFUSED, timeout, offline).
 * Server errors have a response but with error status (4xx, 5xx).
 */
export function isNetworkError(err: unknown): boolean {
  const axiosError = err as any
  return !axiosError?.response
}
