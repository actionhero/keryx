/** Redis key builders for OAuth records. */
export const clientKey = (id: string) => `oauth:client:${id}`;
export const codeKey = (code: string) => `oauth:code:${code}`;
export const accessKey = (token: string) => `oauth:token:${token}`;
export const refreshKey = (token: string) => `oauth:refresh:${token}`;

/**
 * When looking up an unknown bearer token (introspect/revoke), the caller may
 * pass `token_type_hint` to hint at which keyspace to try first. Tokens are
 * UUIDs so there is no collision risk; the hint is purely an optimization.
 */
export function tokenLookupOrder(
  token: string,
  hint: string | null,
): [string, string] {
  return hint === "refresh_token"
    ? [refreshKey(token), accessKey(token)]
    : [accessKey(token), refreshKey(token)];
}
