import { Action, api, config, HTTP_METHOD } from "keryx";
import { z } from "zod";
import pkg from "../package.json";

const SWAGGER_VERSION = "3.0.0";

const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

const swaggerResponses = {
  "200": {
    description: "successful operation",
    content: {
      "application/json": {
        schema: {},
      },
    },
  },
  "400": {
    description: "Invalid input",
    content: {
      "application/json": {
        schema: errorResponseSchema,
      },
    },
  },
  "404": {
    description: "Not Found",
    content: {
      "application/json": {
        schema: errorResponseSchema,
      },
    },
  },
  "422": {
    description: "Missing or invalid params",
    content: {
      "application/json": {
        schema: errorResponseSchema,
      },
    },
  },
  "500": {
    description: "Server error",
    content: {
      "application/json": {
        schema: errorResponseSchema,
      },
    },
  },
};

export class Swagger implements Action {
  name = "swagger";
  description =
    "Returns the full API documentation as an OpenAPI 3.0.0 JSON document. Includes all available endpoints with their routes, methods, request schemas, response schemas, and parameter descriptions. Does not require authentication.";
  web = { route: "/swagger", method: HTTP_METHOD.GET };

  async run() {
    const paths: Record<string, Record<string, unknown>> = {};
    const components: {
      schemas: Record<string, unknown>;
      securitySchemes?: Record<string, unknown>;
    } = {
      schemas: {},
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: config.session.cookieName,
          description: "Session cookie set by session:create",
        },
      },
    };

    for (const action of api.actions.actions) {
      if (!action.web?.route || !action.web?.method) continue;
      // Skip RegExp routes for swagger documentation
      if (typeof action.web.route !== "string") continue;
      // Convert :param format to OpenAPI {param} format
      const path = action.web.route.replace(
        /:\w+/g,
        (match: string) => `{${match.slice(1)}}`,
      );
      const method = action.web.method.toLowerCase();
      const tag = action.name.split(":")[0];
      const operationId = action.name;
      const summary = action.name;
      const description = action.description;

      // Extract path parameters from the original route
      const parameters: Array<Record<string, unknown>> = [];
      const pathParamMatches = action.web.route.match(/:\w+/g) || [];
      const pathParamNames = new Set<string>();

      // Pre-compute Zod JSON Schema for enriching path param types
      let zodProperties: Record<string, Record<string, unknown>> = {};
      let zodDescriptions: Record<string, string> = {};
      if (action.inputs && typeof action.inputs.parse === "function") {
        const jsonSchema = z.toJSONSchema(action.inputs, {
          io: "input",
          unrepresentable: "any",
        }) as Record<string, unknown>;
        zodProperties =
          (jsonSchema.properties as Record<string, Record<string, unknown>>) ??
          {};
        for (const [name, propSchema] of Object.entries(zodProperties)) {
          if (typeof propSchema.description === "string") {
            zodDescriptions[name] = propSchema.description;
          }
        }
      }

      for (const paramMatch of pathParamMatches) {
        const paramName = paramMatch.slice(1); // Remove the colon
        pathParamNames.add(paramName);
        parameters.push({
          name: paramName,
          in: "path",
          required: true,
          schema: { type: "string" },
          description:
            zodDescriptions[paramName] ?? `The ${paramName} parameter`,
        });
      }

      // For GET/HEAD, convert remaining Zod inputs into query parameters
      if (
        (method === "get" || method === "head") &&
        Object.keys(zodProperties).length > 0
      ) {
        const fullSchema = z.toJSONSchema(action.inputs!, {
          io: "input",
          unrepresentable: "any",
        }) as Record<string, unknown>;
        const requiredFields = new Set<string>(
          (fullSchema.required as string[] | undefined) ?? [],
        );
        for (const [name, propSchema] of Object.entries(zodProperties)) {
          if (pathParamNames.has(name)) continue; // already a path param
          parameters.push({
            name,
            in: "query",
            required: requiredFields.has(name),
            schema: propSchema,
            ...(typeof propSchema.description === "string"
              ? { description: propSchema.description }
              : {}),
          });
        }
      }

      // Build requestBody if Zod inputs exist and method supports body
      let requestBody: Record<string, unknown> | undefined = undefined;
      if (
        action.inputs &&
        typeof action.inputs.parse === "function" &&
        method !== "get" &&
        method !== "head"
      ) {
        const zodSchema = action.inputs;
        const schemaName = `${action.name.replace(/:/g, "_")}_Request`;
        // Use io: "input" to get the input schema (before transforms)
        // Use unrepresentable: "any" to handle refinements, async transforms, etc.
        const jsonSchema = z.toJSONSchema(zodSchema, {
          io: "input",
          unrepresentable: "any",
        }) as Record<string, unknown>;
        // Remove $schema from component schemas (not needed in OpenAPI)
        const { $schema, ...schemaWithout$schema } = jsonSchema;
        components.schemas[schemaName] = schemaWithout$schema;
        requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        };
      }

      // Build responses - use generated schema if available
      const responses: Record<string, unknown> = JSON.parse(
        JSON.stringify(swaggerResponses),
      );
      const responseSchema = api.swagger?.responseSchemas[action.name];
      if (responseSchema) {
        const schemaName = `${action.name.replace(/:/g, "_")}_Response`;
        components.schemas[schemaName] = responseSchema;
        responses["200"] = {
          description: "successful operation",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        };
      }

      // Add path/method
      if (!paths[path]) paths[path] = {};
      paths[path][method] = {
        operationId,
        summary,
        ...(description ? { description } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
        tags: [tag],
      };
    }

    const document = {
      openapi: SWAGGER_VERSION,
      info: {
        version: pkg.version,
        title: pkg.name,
        license: { name: pkg.license },
        description: pkg.description,
      },
      servers: [
        {
          url: config.server.web.applicationUrl + config.server.web.apiRoute,
          description: pkg.description,
        },
      ],
      paths,
      components,
      security: [{ sessionCookie: [] }],
    };
    return document;
  }
}
