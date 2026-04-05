/**
 * Categorizes all framework errors. Each type maps to an HTTP status code via `ErrorStatusCodes`.
 * Actions should always throw `TypedError` with one of these types.
 */
export enum ErrorType {
  // general
  SERVER_INITIALIZATION = "SERVER_INITIALIZATION",
  SERVER_START = "SERVER_START",
  SERVER_STOP = "SERVER_STOP",

  // init
  CONFIG_ERROR = "CONFIG_ERROR",
  INITIALIZER_VALIDATION = "INITIALIZER_VALIDATION",
  ACTION_VALIDATION = "ACTION_VALIDATION",
  TASK_VALIDATION = "TASK_VALIDATION",
  SERVER_VALIDATION = "SERVER_VALIDATION",

  // session
  CONNECTION_SESSION_NOT_FOUND = "CONNECTION_SESSION_NOT_FOUND",

  // actions
  CONNECTION_SERVER_ERROR = "CONNECTION_SERVER_ERROR",
  CONNECTION_ACTION_NOT_FOUND = "CONNECTION_ACTION_NOT_FOUND",
  CONNECTION_ACTION_PARAM_REQUIRED = "CONNECTION_ACTION_PARAM_REQUIRED",
  CONNECTION_ACTION_PARAM_DEFAULT = "CONNECTION_ACTION_PARAM_DEFAULT",
  CONNECTION_ACTION_PARAM_VALIDATION = "CONNECTION_ACTION_PARAM_VALIDATION",
  CONNECTION_ACTION_PARAM_FORMATTING = "CONNECTION_ACTION_PARAM_FORMATTING",
  CONNECTION_ACTION_RUN = "CONNECTION_ACTION_RUN",
  CONNECTION_TYPE_NOT_FOUND = "CONNECTION_TYPE_NOT_FOUND",
  CONNECTION_NOT_SUBSCRIBED = "CONNECTION_NOT_SUBSCRIBED",
  CONNECTION_CHANNEL_AUTHORIZATION = "CONNECTION_CHANNEL_AUTHORIZATION",
  CONNECTION_CHANNEL_VALIDATION = "CONNECTION_CHANNEL_VALIDATION",

  CONNECTION_ACTION_TIMEOUT = "CONNECTION_ACTION_TIMEOUT",
  CONNECTION_RATE_LIMITED = "CONNECTION_RATE_LIMITED",

  CONNECTION_TASK_DEFINITION = "CONNECTION_TASK_DEFINITION",
}

/** Maps each `ErrorType` to the HTTP status code returned to the client. */
export const ErrorStatusCodes: Record<ErrorType, number> = {
  [ErrorType.SERVER_INITIALIZATION]: 500,
  [ErrorType.SERVER_START]: 500,
  [ErrorType.SERVER_STOP]: 500,

  [ErrorType.CONFIG_ERROR]: 500,

  [ErrorType.INITIALIZER_VALIDATION]: 500,
  [ErrorType.ACTION_VALIDATION]: 500,
  [ErrorType.TASK_VALIDATION]: 500,
  [ErrorType.SERVER_VALIDATION]: 500,

  [ErrorType.CONNECTION_SESSION_NOT_FOUND]: 401,
  [ErrorType.CONNECTION_SERVER_ERROR]: 500,
  [ErrorType.CONNECTION_ACTION_NOT_FOUND]: 404,
  [ErrorType.CONNECTION_ACTION_PARAM_REQUIRED]: 406,
  [ErrorType.CONNECTION_ACTION_PARAM_DEFAULT]: 406,
  [ErrorType.CONNECTION_ACTION_PARAM_VALIDATION]: 406,
  [ErrorType.CONNECTION_ACTION_PARAM_FORMATTING]: 406,
  [ErrorType.CONNECTION_ACTION_RUN]: 500,
  [ErrorType.CONNECTION_TYPE_NOT_FOUND]: 406,
  [ErrorType.CONNECTION_NOT_SUBSCRIBED]: 406,
  [ErrorType.CONNECTION_CHANNEL_AUTHORIZATION]: 403,
  [ErrorType.CONNECTION_CHANNEL_VALIDATION]: 400,
  [ErrorType.CONNECTION_ACTION_TIMEOUT]: 408,
  [ErrorType.CONNECTION_RATE_LIMITED]: 429,

  [ErrorType.CONNECTION_TASK_DEFINITION]: 500,
};

export type TypedErrorArgs = {
  /** Human-readable error message returned to the client. */
  message: string;
  /** The error category, which determines the HTTP status code. */
  type: ErrorType;
  /** The original caught error, if wrapping. Its stack trace is preserved on the `TypedError`. */
  originalError?: unknown;
  /** The param key that caused the error (for validation errors). */
  key?: string;
  /** The param value that caused the error (for validation errors). */
  value?: any;
};

/**
 * Structured error class for action and framework failures. Extends `Error` with an
 * `ErrorType` that maps to an HTTP status code, and optional `key`/`value` fields for
 * param validation errors. If `originalError` is provided, its stack trace is preserved.
 */
export class TypedError extends Error {
  /** The error category, used to determine the HTTP status code via `ErrorStatusCodes`. */
  type: ErrorType;
  /** The param key that caused the error (for validation errors). */
  key?: string;
  /** The param value that caused the error (for validation errors). */
  value?: any;

  constructor(args: TypedErrorArgs) {
    super(args.message);
    this.type = args.type;
    this.key = args.key;
    this.value = args.value;

    if (args.originalError !== undefined) {
      if (args.originalError instanceof Error) {
        this.stack = args.originalError.stack;
      } else {
        this.stack = `OriginalStringError: ${args.originalError}`;
      }
    }
  }
}
