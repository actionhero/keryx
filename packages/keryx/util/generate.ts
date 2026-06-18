import fs from "fs";
import Mustache from "mustache";
import path from "path";
import {
  buildComponentView,
  getComponentDef,
  getValidTypes,
  loadGenerateTemplate,
  resolveComponentPath,
  resolveTestPath,
} from "./componentRegistry";
import { readFileText, writeFile } from "./runtime";

export { getValidTypes } from "./componentRegistry";

export interface GenerateOptions {
  dryRun?: boolean;
  force?: boolean;
  noTest?: boolean;
}

/**
 * Generate a component file (and optionally a test file).
 * @param type The component type to generate
 * @param name The component name (e.g., "user:delete", "cache")
 * @param rootDir The project root directory
 * @param options Generation options (dry-run, force, no-test)
 * @returns List of created (or would-be-created) file paths
 */
export async function generateComponent(
  type: string,
  name: string,
  rootDir: string,
  options: GenerateOptions = {},
): Promise<string[]> {
  const def = getComponentDef(type);
  if (!def) {
    throw new Error(
      `Unknown generator type "${type}". Valid types: ${getValidTypes().join(", ")}`,
    );
  }

  const filePath = resolveComponentPath(def, name);
  const fullPath = path.join(rootDir, filePath);
  const createdFiles: string[] = [];

  if (!options.force && fs.existsSync(fullPath)) {
    throw new Error(
      `File already exists: ${filePath}. Use --force to overwrite.`,
    );
  }

  const view = buildComponentView(def, name);
  const template = await readFileText(def.templatePath);
  const content = Mustache.render(template, view);

  if (options.dryRun) {
    console.log(`Would create: ${filePath}`);
    console.log("---");
    console.log(content);
    createdFiles.push(filePath);
  } else {
    await writeFile(fullPath, content);
    createdFiles.push(filePath);
  }

  if (!options.noTest) {
    const testPath = resolveTestPath(filePath);
    const testFullPath = path.join(rootDir, testPath);

    if (!options.force && fs.existsSync(testFullPath)) {
      // Silently skip test file if it already exists
    } else {
      const testTemplate = def.testTemplatePath
        ? await readFileText(def.testTemplatePath)
        : await loadGenerateTemplate("test.ts.mustache");
      const testContent = Mustache.render(testTemplate, view);

      if (options.dryRun) {
        console.log(`Would create: ${testPath}`);
        createdFiles.push(testPath);
      } else {
        await writeFile(testFullPath, testContent);
        createdFiles.push(testPath);
      }
    }
  }

  return createdFiles;
}
