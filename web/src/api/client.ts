/** Read a cookie value without depending on a third-party cookie library. */
const readCookie = (name: string) =>
  document.cookie
    .split("; ")
    .find((v) => v.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

/** Error thrown when the API returns a non-2xx response. */
export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Perform a same-origin API request and unwrap the common
 * `{ data, error }` response envelope.
 */
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const method = (options.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    let csrf = readCookie("wt_csrf");
    if (!csrf) {
      const r = await fetch("/api/v1/auth/csrf", {
        credentials: "same-origin",
      });
      const j = await r.json();
      csrf = j.data.csrfToken;
    }
    headers.set("X-CSRF-Token", decodeURIComponent(csrf!));
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new APIError(
      json.error?.code ?? "REQUEST_FAILED",
      json.error?.message ?? "请求失败",
      response.status,
    );
  return json.data as T;
}

/** Serialize a request body as JSON. */
export const json = (value: unknown) => JSON.stringify(value);
