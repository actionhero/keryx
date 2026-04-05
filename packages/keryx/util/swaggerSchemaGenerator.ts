import { mkdir } from "fs/promises";
import path from "path";
import type { Type } from "ts-morph";

export type JSONSchema = {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  oneOf?: JSONSchema[];
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  enum?: (string | number | boolean | null)[];
  const?: unknown;
  $ref?: string;
  description?: string;
};

/**
 * Convert a ts-morph Type to JSON Schema format.
 *
 * @param type - The ts-morph Type to convert
 * @param visited - Set of type text strings already visited (prevents infinite recursion for circular types)
 * @returns A JSON Schema representation of the type
 */
export function typeToJsonSchema(
  type: Type,
  visited: Set<string> = new Set(),
): JSONSchema {
  const typeText = type.getText();

  // Prevent infinite recursion for circular types
  if (visited.has(typeText)) {
    return { type: "object", additionalProperties: true };
  }

  // Handle Promise<T> - unwrap to T
  if (
    type.getSymbol()?.getName() === "Promise" ||
    typeText.startsWith("Promise<")
  ) {
    const typeArgs = type.getTypeArguments();
    if (typeArgs.length > 0) {
      return typeToJsonSchema(typeArgs[0], visited);
    }
  }

  // Handle primitives
  if (type.isString() || type.isStringLiteral()) {
    if (type.isStringLiteral()) {
      return { type: "string", const: type.getLiteralValue() };
    }
    return { type: "string" };
  }

  if (type.isNumber() || type.isNumberLiteral()) {
    if (type.isNumberLiteral()) {
      return { type: "number", const: type.getLiteralValue() };
    }
    return { type: "number" };
  }

  if (type.isBoolean() || type.isBooleanLiteral()) {
    if (type.isBooleanLiteral()) {
      return { type: "boolean", const: type.getLiteralValue() };
    }
    return { type: "boolean" };
  }

  if (type.isNull()) {
    return { type: "null" as any };
  }

  if (type.isUndefined()) {
    return { type: "undefined" as any };
  }

  // Handle arrays
  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      return {
        type: "array",
        items: typeToJsonSchema(elementType, visited),
      };
    }
    return { type: "array" };
  }

  // Handle unions (but not boolean which is true | false)
  if (type.isUnion() && !type.isBoolean()) {
    const unionTypes = type.getUnionTypes();
    // Filter out undefined for optional properties
    const nonUndefinedTypes = unionTypes.filter((t) => !t.isUndefined());
    if (nonUndefinedTypes.length === 1) {
      return typeToJsonSchema(nonUndefinedTypes[0], visited);
    }
    return {
      oneOf: nonUndefinedTypes.map((t) => typeToJsonSchema(t, visited)),
    };
  }

  // Handle objects/interfaces
  if (type.isObject()) {
    // Check if it's a Date
    if (type.getSymbol()?.getName() === "Date") {
      return { type: "string", description: "ISO 8601 date string" };
    }

    // Add to visited set to prevent recursion
    const newVisited = new Set(visited);
    newVisited.add(typeText);

    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];

    const typeProperties = type.getProperties();
    for (const prop of typeProperties) {
      const propName = prop.getName();
      // Skip internal properties
      if (propName.startsWith("_")) continue;

      // Try to get the type - use getTypeAtLocation if declaration exists, otherwise use getDeclaredType
      let propType: Type | undefined;
      const valueDecl = prop.getValueDeclaration();
      if (valueDecl) {
        propType = prop.getTypeAtLocation(valueDecl);
      } else {
        // For computed types without a direct declaration, get the type from declarations
        const declarations = prop.getDeclarations();
        if (declarations.length > 0) {
          propType = prop.getTypeAtLocation(declarations[0]);
        }
      }

      if (!propType) continue;

      properties[propName] = typeToJsonSchema(propType, newVisited);

      // Check if property is optional
      if (!prop.isOptional()) {
        required.push(propName);
      }
    }

    const schema: JSONSchema = {
      type: "object",
      properties,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    return schema;
  }

  // Handle any/unknown
  if (type.isAny() || type.isUnknown()) {
    return { type: "object", additionalProperties: true };
  }

  // Fallback for complex types
  return { type: "object", additionalProperties: true };
}

/**
 * Compute a SHA256 hash of all TypeScript action source files.
 * Used to detect when actions have changed and the cache needs regeneration.
 *
 * @param rootDir - The application root directory containing the `actions/` folder
 * @returns Hex-encoded SHA256 hash string
 */
export async function computeActionsHash(rootDir: string): Promise<string> {
  const actionsDirs = [path.join(rootDir, "actions")];
  const glob = new Bun.Glob("**/*.ts");
  const hasher = new Bun.CryptoHasher("sha256");
  for (const actionsDir of actionsDirs) {
    try {
      const actionFiles = Array.from(glob.scanSync(actionsDir)).sort();
      for (const file of actionFiles) {
        const content = await Bun.file(path.join(actionsDir, file)).text();
        hasher.update(content);
      }
    } catch {
      // Directory may not exist
    }
  }
  return hasher.digest("hex") as string;
}

/**
 * Load cached swagger schemas from disk.
 *
 * @param rootDir - The application root directory containing the `.cache/` folder
 * @returns The cached data (hash + responseSchemas) or null if cache is missing/corrupted
 */
export async function loadCachedSchemas(rootDir: string): Promise<{
  hash: string;
  responseSchemas: Record<string, JSONSchema>;
} | null> {
  const cacheFile = path.join(rootDir, ".cache", "swagger-schemas.json");
  const cacheFileHandle = Bun.file(cacheFile);
  if (await cacheFileHandle.exists()) {
    try {
      const cached = await cacheFileHandle.json();
      if (cached.hash && cached.responseSchemas) {
        return cached;
      }
    } catch {
      // Cache file corrupted
    }
  }
  return null;
}

/**
 * Run the full ts-morph analysis to generate JSON Schema representations
 * of all Action return types.
 *
 * @param opts - rootDir and packageDir paths for source file discovery
 * @param opts.rootDir - The application root directory
 * @param opts.packageDir - The keryx framework package directory
 * @returns Hash of action files and generated response schemas
 */
export async function generateSwaggerSchemas(opts: {
  rootDir: string;
  packageDir: string;
}): Promise<{ hash: string; responseSchemas: Record<string, JSONSchema> }> {
  const { rootDir, packageDir } = opts;
  const hash = await computeActionsHash(rootDir);
  const responseSchemas: Record<string, JSONSchema> = {};

  // Dynamic import so ts-morph is only loaded when actually generating
  const { Project, ts } = await import("ts-morph");

  const tsConfigPath = path.join(rootDir, "tsconfig.json");
  const hasTsConfig = await Bun.file(tsConfigPath).exists();

  const project = new Project({
    ...(hasTsConfig ? { tsConfigFilePath: tsConfigPath } : {}),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });

  // Add all source files so types can be resolved across the codebase
  project.addSourceFilesAtPaths(path.join(packageDir, "**/*.ts"));
  if (rootDir !== packageDir) {
    project.addSourceFilesAtPaths(path.join(rootDir, "**/*.ts"));
  }
  // Exclude test files
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.getFilePath().includes("__tests__")) {
      project.removeSourceFile(sourceFile);
    }
  }

  // Process each source file
  for (const sourceFile of project.getSourceFiles()) {
    const classes = sourceFile.getClasses();

    for (const classDecl of classes) {
      // Check if class implements Action (has name property and run method)
      const nameProperty = classDecl.getProperty("name");
      const runMethod =
        classDecl.getMethod("run") || classDecl.getProperty("run"); // run can be a property with arrow function

      if (!nameProperty || !runMethod) continue;

      // Get action name from the name property initializer
      const nameInitializer = nameProperty.getInitializer();
      if (!nameInitializer) continue;

      let actionName = nameInitializer.getText();
      // Remove quotes from string literal
      actionName = actionName.replace(/^["']|["']$/g, "");

      // Get return type of run method
      let returnType: Type | undefined;

      if (runMethod.getKind() === ts.SyntaxKind.MethodDeclaration) {
        // It's a method
        const method = classDecl.getMethod("run");
        if (method) {
          returnType = method.getReturnType();
        }
      } else {
        // It's a property (arrow function)
        const prop = classDecl.getProperty("run");
        if (prop) {
          const propType = prop.getType();
          // Get the return type from the function type
          const callSignatures = propType.getCallSignatures();
          if (callSignatures.length > 0) {
            returnType = callSignatures[0].getReturnType();
          }
        }
      }

      if (returnType) {
        const schema = typeToJsonSchema(returnType);
        responseSchemas[actionName] = schema;
      }
    }
  }

  return { hash, responseSchemas };
}

/**
 * Write swagger schema cache to disk.
 *
 * @param rootDir - The application root directory where `.cache/` will be created
 * @param data - The hash and response schemas to cache
 */
export async function writeSchemasCache(
  rootDir: string,
  data: { hash: string; responseSchemas: Record<string, JSONSchema> },
): Promise<void> {
  const cacheDir = path.join(rootDir, ".cache");
  await mkdir(cacheDir, { recursive: true });
  await Bun.write(
    path.join(cacheDir, "swagger-schemas.json"),
    JSON.stringify(data, null, 2),
  );
}
