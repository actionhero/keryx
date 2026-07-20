// Invalid theme entrypoint fixture: default export is not a CSS string, which
// resolveThemeCss must reject.
export default { not: "a string" };
