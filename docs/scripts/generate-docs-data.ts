/**
 * Generate documentation data from the backend source code.
 * Parses action, initializer, and config files using ts-morph.
 *
 * Usage: bun run scripts/generate-docs-data.ts
 */

import { mkdir } from "fs/promises";
import path from "path";
import { Project, type Type, ts } from "ts-morph";

const rootDir = path.resolve(import.meta.dir, "../../backend");
const outDir = path.resolve(import.meta.dir, "../.vitepress/data");

type JSONSchema = {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  oneOf?: JSONSchema[];
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  enum?: (string | number | boolean | null)[];
  const?: unknown;
  description?: string;
};

function typeToJsonSchema(
  type: Type,
  visited: Set<string> = new Set(),
): JSONSchema {
  const typeText = type.getText();
  if (visited.has(typeText))
    return { type: "object", additionalProperties: true };

  if (
    type.getSymbol()?.getName() === "Promise" ||
    typeText.startsWith("Promise<")
  ) {
    const typeArgs = type.getTypeArguments();
    if (typeArgs.length > 0) return typeToJsonSchema(typeArgs[0], visited);
  }

  if (type.isString() || type.isStringLiteral()) {
    if (type.isStringLiteral())
      return { type: "string", const: type.getLiteralValue() };
    return { type: "string" };
  }
  if (type.isNumber() || type.isNumberLiteral()) {
    if (type.isNumberLiteral())
      return { type: "number", const: type.getLiteralValue() };
    return { type: "number" };
  }
  if (type.isBoolean() || type.isBooleanLiteral()) {
    if (type.isBooleanLiteral())
      return { type: "boolean", const: type.getLiteralValue() };
    return { type: "boolean" };
  }
  if (type.isNull()) return { type: "null" };
  if (type.isUndefined()) return { type: "undefined" };

  if (type.isArray()) {
    const el = type.getArrayElementType();
    if (el) return { type: "array", items: typeToJsonSchema(el, visited) };
    return { type: "array" };
  }

  if (type.isUnion() && !type.isBoolean()) {
    const nonUndef = type.getUnionTypes().filter((t) => !t.isUndefined());
    if (nonUndef.length === 1) return typeToJsonSchema(nonUndef[0], visited);
    return { oneOf: nonUndef.map((t) => typeToJsonSchema(t, visited)) };
  }

  if (type.isObject()) {
    if (type.getSymbol()?.getName() === "Date")
      return { type: "string", description: "ISO 8601 date string" };

    const newVisited = new Set(visited);
    newVisited.add(typeText);
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];

    for (const prop of type.getProperties()) {
      const name = prop.getName();
      if (name.startsWith("_")) continue;
      let propType: Type | undefined;
      const valueDecl = prop.getValueDeclaration();
      if (valueDecl) {
        propType = prop.getTypeAtLocation(valueDecl);
      } else {
        const decls = prop.getDeclarations();
        if (decls.length > 0) propType = prop.getTypeAtLocation(decls[0]);
      }
      if (!propType) continue;
      properties[name] = typeToJsonSchema(propType, newVisited);
      if (!prop.isOptional()) required.push(name);
    }

    const schema: JSONSchema = { type: "object", properties };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  if (type.isAny() || type.isUnknown())
    return { type: "object", additionalProperties: true };

  return { type: "object", additionalProperties: true };
}

// --- Main ---

console.log("Generating docs data from", rootDir);

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
});

project.addSourceFilesAtPaths(path.join(rootDir, "**/*.ts"));
for (const sf of project.getSourceFiles()) {
  if (sf.getFilePath().includes("__tests__")) project.removeSourceFile(sf);
}

// --- Extract Actions ---
type ActionInfo = {
  name: string;
  description: string;
  route?: string;
  method?: string;
  taskQueue?: string;
  taskFrequency?: number;
  middleware: string[];
  inputs: { name: string; type: string; required: boolean }[];
  responseSchema?: JSONSchema;
  sourceFile: string;
};

const actions: ActionInfo[] = [];

for (const sf of project.getSourceFiles()) {
  if (!sf.getFilePath().includes("/actions/")) continue;
  if (sf.getFilePath().endsWith(".index.ts")) continue;

  for (const classDecl of sf.getClasses()) {
    const nameProp = classDecl.getProperty("name");
    const runMethod =
      classDecl.getMethod("run") || classDecl.getProperty("run");
    if (!nameProp || !runMethod) continue;

    const nameInit = nameProp.getInitializer();
    if (!nameInit) continue;
    const actionName = nameInit.getText().replace(/^["']|["']$/g, "");

    // Description
    const descProp = classDecl.getProperty("description");
    const descInit = descProp?.getInitializer();
    const description = descInit
      ? descInit.getText().replace(/^["']|["']$/g, "")
      : actionName;

    // Web route/method
    const webProp = classDecl.getProperty("web");
    let route: string | undefined;
    let method: string | undefined;
    if (webProp) {
      const webInit = webProp.getInitializer();
      if (webInit) {
        const webText = webInit.getText();
        const routeMatch = webText.match(/route:\s*["']([^"']+)["']/);
        const methodMatch = webText.match(/method:\s*(?:HTTP_METHOD\.)?(\w+)/);
        if (routeMatch) route = routeMatch[1];
        if (methodMatch) method = methodMatch[1];
      }
    }

    // Task config
    const taskProp = classDecl.getProperty("task");
    let taskQueue: string | undefined;
    let taskFrequency: number | undefined;
    if (taskProp) {
      const taskInit = taskProp.getInitializer();
      if (taskInit) {
        const taskText = taskInit.getText();
        const queueMatch = taskText.match(/queue:\s*["']([^"']+)["']/);
        const freqMatch = taskText.match(/frequency:\s*([0-9*\s]+)/);
        if (queueMatch) taskQueue = queueMatch[1];
        if (freqMatch) {
          try {
            taskFrequency = eval(freqMatch[1].trim());
          } catch {}
        }
      }
    }

    // Middleware
    const mwProp = classDecl.getProperty("middleware");
    const middleware: string[] = [];
    if (mwProp) {
      const mwInit = mwProp.getInitializer();
      if (mwInit) {
        const mwText = mwInit.getText();
        const mwMatches = mwText.match(/\w+Middleware/g);
        if (mwMatches) middleware.push(...mwMatches);
      }
    }

    // Inputs
    const inputs: { name: string; type: string; required: boolean }[] = [];
    const inputsProp = classDecl.getProperty("inputs");
    if (inputsProp) {
      const inputsInit = inputsProp.getInitializer();
      if (inputsInit) {
        const inputsText = inputsInit.getText();
        // Parse z.object({ ... }) fields
        const fieldRegex =
          /(\w+):\s*(?:secret\()?z(?:\.coerce)?\.(\w+)\(([^)]*)\)([^,}]*)/g;
        let match;
        while ((match = fieldRegex.exec(inputsText)) !== null) {
          const fieldName = match[1];
          const zodType = match[2];
          const rest = match[4] || "";
          const isOptional =
            rest.includes(".optional()") || rest.includes(".default(");
          inputs.push({
            name: fieldName,
            type: zodType === "coerce" ? "number" : zodType,
            required: !isOptional,
          });
        }
      }
    }

    // Response schema
    let responseSchema: JSONSchema | undefined;
    try {
      let returnType: Type | undefined;
      if (runMethod.getKind() === ts.SyntaxKind.MethodDeclaration) {
        const m = classDecl.getMethod("run");
        if (m) returnType = m.getReturnType();
      } else {
        const p = classDecl.getProperty("run");
        if (p) {
          const sigs = p.getType().getCallSignatures();
          if (sigs.length > 0) returnType = sigs[0].getReturnType();
        }
      }
      if (returnType) responseSchema = typeToJsonSchema(returnType);
    } catch {}

    const relPath = path.relative(rootDir, sf.getFilePath());

    actions.push({
      name: actionName,
      description,
      route,
      method,
      taskQueue,
      taskFrequency,
      middleware,
      inputs,
      responseSchema,
      sourceFile: relPath,
    });
  }
}

actions.sort((a, b) => a.name.localeCompare(b.name));

// --- Extract Initializers ---
type InitializerInfo = {
  name: string;
  loadPriority: number;
  startPriority: number;
  stopPriority: number;
  namespace: string;
  sourceFile: string;
};

const initializers: InitializerInfo[] = [];

for (const sf of project.getSourceFiles()) {
  if (!sf.getFilePath().includes("/initializers/")) continue;

  for (const classDecl of sf.getClasses()) {
    // Check if extends Initializer
    const heritage = classDecl.getHeritageClauses();
    const extendsInitializer = heritage.some((h) =>
      h.getText().includes("Initializer"),
    );
    if (!extendsInitializer) continue;

    // Get namespace from constructor super() call or variable
    let namespace = classDecl.getName()?.toLowerCase() || "unknown";

    // Try to find the namespace variable
    const nsVar = sf.getVariableDeclaration("namespace");
    if (nsVar) {
      const init = nsVar.getInitializer();
      if (init) namespace = init.getText().replace(/^["']|["']$/g, "");
    }

    // Get priorities from constructor
    let loadPriority = 1000;
    let startPriority = 1000;
    let stopPriority = 1000;

    const ctor = classDecl.getConstructors()[0];
    if (ctor) {
      const body = ctor.getBody()?.getText() || "";
      const loadMatch = body.match(/this\.loadPriority\s*=\s*(\d+)/);
      const startMatch = body.match(/this\.startPriority\s*=\s*(\d+)/);
      const stopMatch = body.match(/this\.stopPriority\s*=\s*(\d+)/);
      if (loadMatch) loadPriority = parseInt(loadMatch[1]);
      if (startMatch) startPriority = parseInt(startMatch[1]);
      if (stopMatch) stopPriority = parseInt(stopMatch[1]);
    }

    const relPath = path.relative(rootDir, sf.getFilePath());
    initializers.push({
      name: classDecl.getName() || "Unknown",
      loadPriority,
      startPriority,
      stopPriority,
      namespace,
      sourceFile: relPath,
    });
  }
}

initializers.sort((a, b) => a.loadPriority - b.loadPriority);

// --- Extract Config ---
type ConfigInfo = {
  section: string;
  keys: { name: string; envVar: string; defaultValue: string }[];
  sourceFile: string;
};

const configs: ConfigInfo[] = [];

for (const sf of project.getSourceFiles()) {
  if (!sf.getFilePath().includes("/config/")) continue;
  if (sf.getFilePath().endsWith("index.ts")) continue;

  const relPath = path.relative(rootDir, sf.getFilePath());
  const section = path.basename(sf.getFilePath(), ".ts");

  const keys: { name: string; envVar: string; defaultValue: string }[] = [];

  // Find loadFromEnvIfSet calls
  const text = sf.getText();
  const callRegex =
    /(\w+):\s*await\s+loadFromEnvIfSet\s*(?:<[^>]+>)?\(\s*["'](\w+)["']\s*,\s*([^)]+)\)/g;
  let match;
  while ((match = callRegex.exec(text)) !== null) {
    keys.push({
      name: match[1],
      envVar: match[2],
      defaultValue: match[3].trim(),
    });
  }

  if (keys.length > 0) {
    configs.push({ section, keys, sourceFile: relPath });
  }
}

// --- Write output ---
await mkdir(outDir, { recursive: true });

await Bun.write(
  path.join(outDir, "actions.json"),
  JSON.stringify(actions, null, 2),
);
await Bun.write(
  path.join(outDir, "initializers.json"),
  JSON.stringify(initializers, null, 2),
);
await Bun.write(
  path.join(outDir, "config.json"),
  JSON.stringify(configs, null, 2),
);

console.log(
  `Generated: ${actions.length} actions, ${initializers.length} initializers, ${configs.length} config sections`,
);
