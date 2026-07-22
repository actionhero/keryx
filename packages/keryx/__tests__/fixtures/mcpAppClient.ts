// Minimal browser entrypoint used only to exercise the MCP App bundler in tests.
// Intentionally DOM-free so it also typechecks under the framework's Bun tsconfig.
export const marker = "MCP_APP_FIXTURE_MARKER";
Reflect.set(globalThis, "__mcpAppFixtureMarker", marker);
// String literals containing the sequences that would prematurely close the inline
// <script> tag (mirrors react-dom's `innerHTML="<script></script>"`). The bundler must
// HTML-escape these so the module tag survives; see issue #516.
export const breakout = "<script></script>";
export const escapedComment = "<!-- not a real comment -->";
Reflect.set(globalThis, "__mcpAppFixtureBreakout", breakout + escapedComment);
