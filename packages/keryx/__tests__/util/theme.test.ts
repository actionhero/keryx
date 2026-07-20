import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetThemeCache, resolveThemeCss } from "../../util/theme";

const fixturesDir = import.meta.dir + "/../fixtures";
const cssFixture = `${fixturesDir}/theme.css`;
const tsFixture = `${fixturesDir}/theme.ts`;
const badModuleFixture = `${fixturesDir}/themeNotString.ts`;

describe("resolveThemeCss", () => {
  beforeEach(() => resetThemeCache());
  // Clear the module-level cache after every test too, so a resolved (or
  // rejected) theme never leaks into other test files that boot the full API.
  afterEach(() => resetThemeCache());

  test("returns empty string when no theme is configured", async () => {
    expect(await resolveThemeCss("")).toBe("");
  });

  test("memoizes the first resolution across calls", async () => {
    const first = await resolveThemeCss(tsFixture);
    // A second call with a DIFFERENT path returns the cached result until reset.
    const second = await resolveThemeCss(cssFixture);
    expect(second).toBe(first);
    // After reset, the new path is compiled.
    resetThemeCache();
    const third = await resolveThemeCss(cssFixture);
    expect(third).not.toBe(first);
  });

  test("compiles a .css file through bun build", async () => {
    const css = await resolveThemeCss(cssFixture);
    expect(css).toContain(".keryx-theme-fixture");
    expect(css).toContain("--keryx-color-primary");
  });

  test("imports a .ts entrypoint's default-exported CSS string", async () => {
    const css = await resolveThemeCss(tsFixture);
    expect(css).toContain("--keryx-color-primary: #00ccff");
    // `$&`/`$1` survive verbatim (not treated as replacement patterns).
    expect(css).toContain('content: "$& $1"');
  });

  test("resolves a relative path against rootDir", async () => {
    const css = await resolveThemeCss("theme.ts", fixturesDir);
    expect(css).toContain("--keryx-color-primary: #00ccff");
  });

  test("throws when a module entrypoint does not export a CSS string", async () => {
    await expect(resolveThemeCss(badModuleFixture)).rejects.toThrow(
      /must default-export a CSS string/,
    );
  });

  test("throws when the theme file does not exist", async () => {
    await expect(
      resolveThemeCss(`${fixturesDir}/does-not-exist.css`),
    ).rejects.toThrow(/Theme CSS not found/);
  });

  test("throws a targeted error for preprocessor extensions", async () => {
    await expect(resolveThemeCss(`${fixturesDir}/theme.scss`)).rejects.toThrow(
      /cannot compile/,
    );
  });
});
