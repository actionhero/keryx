/**
 * Minimal OpenAPI 3.0 types used by the swagger action to produce a typed
 * specification document. These cover only the subset of the spec we emit;
 * for richer use cases prefer the upstream `openapi-types` package.
 */

export interface OpenApiSchema {
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  description?: string;
  $ref?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  additionalProperties?: boolean | OpenApiSchema;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema: OpenApiSchema;
  description?: string;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content: Record<string, { schema: OpenApiSchema }>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: OpenApiSchema }>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  tags?: string[];
}

export type OpenApiPathItem = Record<string, OpenApiOperation | undefined>;

export interface OpenApiSecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  in?: "cookie" | "header" | "query";
  name?: string;
  description?: string;
  scheme?: string;
}
