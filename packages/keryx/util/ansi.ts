const RESET = "\x1b[0m";

/** ANSI terminal color helpers. Each wraps a string in an escape code and reset suffix. */
export const ansi = {
  gray: (s: string) => `\x1b[90m${s}${RESET}`,
  blue: (s: string) => `\x1b[34m${s}${RESET}`,
  cyan: (s: string) => `\x1b[36m${s}${RESET}`,
  green: (s: string) => `\x1b[32m${s}${RESET}`,
  yellow: (s: string) => `\x1b[33m${s}${RESET}`,
  red: (s: string) => `\x1b[31m${s}${RESET}`,
  magenta: (s: string) => `\x1b[35m${s}${RESET}`,
  bgBlue: (s: string) => `\x1b[44m${s}${RESET}`,
  bgMagenta: (s: string) => `\x1b[45m${s}${RESET}`,
};
