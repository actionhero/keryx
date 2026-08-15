import type * as Sentry from "@sentry/bun";

const namespace = "sentry";

/**
 * Public `api.sentry` surface. Methods are no-ops until the plugin starts
 * with a DSN; they stay safe to call from action code either way.
 */
export type SentryNamespace = {
  enabled: boolean;
  captureException: (exception: unknown) => string | undefined;
  captureMessage: (
    message: string,
    level?: Sentry.SeverityLevel,
  ) => string | undefined;
  setUser: (user: Sentry.User | null) => void;
  setTag: (key: string, value: string) => void;
  flush: (timeoutMs?: number) => Promise<boolean>;
};

declare module "keryx" {
  export interface API {
    [namespace]: SentryNamespace;
  }
}

/**
 * Build the disabled `api.sentry` surface used before start and after stop —
 * every method is a safe no-op so action code never has to null-check it.
 */
export function createNoopNamespace(): SentryNamespace {
  return {
    enabled: false,
    captureException: () => undefined,
    captureMessage: () => undefined,
    setUser: () => {},
    setTag: () => {},
    flush: async () => true,
  };
}
