// Minimal browser entrypoint used only to exercise the MCP App bundler in tests.
// Intentionally DOM-free so it also typechecks under the framework's Bun tsconfig.
export const marker = "MCP_APP_FIXTURE_MARKER";
Reflect.set(globalThis, "__mcpAppFixtureMarker", marker);
