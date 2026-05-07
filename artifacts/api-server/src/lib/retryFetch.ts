export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryFetch(
  url: string,
  options?: RequestInit,
  retryOptions?: RetryOptions,
): Promise<Response> {
  const maxAttempts = retryOptions?.maxAttempts ?? 3;
  const baseDelayMs = retryOptions?.baseDelayMs ?? 500;
  const timeoutMs = retryOptions?.timeoutMs ?? 10000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal });

      // Don't retry 4xx — client errors are not transient
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // 5xx — retry
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      // Don't retry if we're on the last attempt
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }

  throw lastError;
}
