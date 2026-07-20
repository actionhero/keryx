// Theme entrypoint fixture: default-exports a CSS string, as a `.ts` theme must.
// Includes a `$&` sequence to prove the value is inlined literally (not as a
// regex replacement pattern) by the injection helpers.
const primary = "#00ccff";
export default `:root { --keryx-color-primary: ${primary}; }
.keryx-theme-fixture::before { content: "$& $1"; }`;
