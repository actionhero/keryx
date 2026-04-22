/**
 * Default test user credentials. Matches the inline values used in the example
 * backend tests prior to this helper.
 */
export const DEFAULT_TEST_USER = {
  name: "Mario Mario",
  email: "mario@example.com",
  password: "mushroom1",
} as const;

/**
 * Create a test user via HTTP PUT `/api/user`. Defaults to the Mario credentials
 * used across example backend tests; override any field per call.
 *
 * Returns the raw `Response` so callers can assert on status and parse the body
 * into whatever response type they need.
 *
 * @param url - Base server URL (from `useTestServer()`'s getter).
 * @param overrides - Override any of `name`, `email`, `password`.
 */
export async function createTestUser(
  url: string,
  overrides?: Partial<{ name: string; email: string; password: string }>,
): Promise<Response> {
  return fetch(url + "/api/user", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...DEFAULT_TEST_USER, ...overrides }),
  });
}

/**
 * Log in as a test user via HTTP PUT `/api/session`. Pair with `createTestUser`.
 * Returns the raw `Response`.
 */
export async function createTestSession(
  url: string,
  overrides?: Partial<{ email: string; password: string }>,
): Promise<Response> {
  return fetch(url + "/api/session", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: DEFAULT_TEST_USER.email,
      password: DEFAULT_TEST_USER.password,
      ...overrides,
    }),
  });
}
