import { describe, expect, test } from "bun:test";
import { type Action, type ActionResponse, api } from "keryx";
import type { Swagger } from "../../actions/swagger";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

describe("swagger", () => {
  test("the swagger endpoint returns valid OpenAPI 3.0 metadata", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    expect(res.status).toBe(200);
    const response = (await res.json()) as ActionResponse<Swagger>;

    // OpenAPI 3.0 structure
    expect(response.openapi).toBe("3.0.0");
    expect(response.info.title).toBe("keryx-example-backend");
    expect(response.info.version).toBeDefined();
    expect(response.info.license).toBeDefined();
    expect(response.info.description).toBeDefined();

    expect(response.servers).toBeDefined();
    expect(response.servers!.length).toBeGreaterThan(0);
    const serverUrl = response.servers![0].url;
    expect(serverUrl.endsWith("/api") || serverUrl.endsWith("/api/")).toBe(
      true,
    );
  });

  // Helper function to convert route format for swagger tests
  const convertRouteForSwagger = (route: string): string => {
    return route.replace(/:\w+/g, (match) => `{${match.slice(1)}}`);
  };

  test("swagger documents all web actions", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Count web actions (actions with both route and method)
    const webActions = api.actions.actions.filter(
      (action: Action) => action.web?.route && action.web?.method,
    );

    // Count unique routes (since multiple methods on same route are grouped)
    const uniqueRoutes = new Set(
      webActions.map((action: Action) =>
        convertRouteForSwagger(action.web!.route.toString()),
      ),
    );
    expect(Object.keys(response.paths).length).toBe(uniqueRoutes.size);

    // Verify each web action is documented
    for (const action of webActions) {
      const path = convertRouteForSwagger(action.web!.route.toString());
      const method = action.web!.method.toLowerCase();

      expect(response.paths[path]).toBeDefined();
      expect(response.paths[path]![method]).toBeDefined();
      expect(response.paths[path]![method]!.operationId).toBe(action.name);
      expect(response.paths[path]![method]!.summary).toBe(action.name);
      if (action.description) {
        expect(response.paths[path]![method]!.description).toBe(
          action.description,
        );
      }
    }
  });

  test("swagger documents request bodies for actions with inputs", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Find actions with Zod inputs
    const actionsWithInputs = api.actions.actions.filter(
      (action: Action) =>
        action.web?.route && action.web?.method && action.inputs,
    );

    for (const action of actionsWithInputs) {
      const path = convertRouteForSwagger(action.web!.route.toString());
      const method = action.web!.method.toLowerCase();
      const pathObj = response.paths[path]![method]!;

      // GET and HEAD methods should not have requestBody
      if (method === "get" || method === "head") {
        expect(pathObj.requestBody).toBeUndefined();
      } else {
        expect(pathObj.requestBody).toBeDefined();
        expect(pathObj.requestBody!.required).toBe(true);
        expect(pathObj.requestBody!.content["application/json"]).toBeDefined();
        const schema = pathObj.requestBody!.content["application/json"].schema;
        expect(schema).toBeDefined();
        // Should be a $ref
        expect(typeof schema.$ref).toBe("string");
        // The referenced schema should exist in components.schemas
        const refName = schema.$ref.replace("#/components/schemas/", "");
        expect(response.components.schemas[refName]).toBeDefined();
      }
    }
  });

  test("swagger documents standard response codes", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Check a specific endpoint (swagger itself)
    const swaggerPath = response.paths["/swagger"]!.get!;

    expect(swaggerPath.responses["200"]).toBeDefined();
    expect(swaggerPath.responses["400"]).toBeDefined();
    expect(swaggerPath.responses["404"]).toBeDefined();
    expect(swaggerPath.responses["422"]).toBeDefined();
    expect(swaggerPath.responses["500"]).toBeDefined();

    // Verify response schemas
    expect(
      swaggerPath.responses["200"]!.content["application/json"].schema,
    ).toBeDefined();
    expect(
      swaggerPath.responses["400"]!.content["application/json"].schema,
    ).toBeDefined();
  });

  test("swagger groups actions by tags", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Check that actions are tagged by their namespace
    for (const action of api.actions.actions) {
      if (!action.web?.route || !action.web?.method) continue;

      const path = convertRouteForSwagger(action.web.route.toString());
      const method = action.web.method.toLowerCase();
      const pathObj = response.paths[path]![method]!;

      expect(pathObj.tags).toBeDefined();
      expect(pathObj.tags!.length).toBeGreaterThan(0);

      const expectedTag = action.name.split(":")[0];
      expect(pathObj.tags).toContain(expectedTag);
    }
  });

  test("swagger documents query parameters for GET actions", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // messages:list is GET /messages/list with page and limit inputs
    const messagesListOp = response.paths["/messages/list"]!.get!;
    expect(messagesListOp.parameters).toBeDefined();

    const limitParam = messagesListOp.parameters!.find(
      (p: any) => p.name === "limit",
    );
    expect(limitParam).toBeDefined();
    expect(limitParam!.in).toBe("query");

    const pageParam = messagesListOp.parameters!.find(
      (p: any) => p.name === "page",
    );
    expect(pageParam).toBeDefined();
    expect(pageParam!.in).toBe("query");

    // GET actions should not have requestBody
    expect(messagesListOp.requestBody).toBeUndefined();
  });

  test("swagger does not duplicate path params as query params", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // user:view is GET /user/:user — "user" is a path param and a Zod input
    const userViewOp = response.paths["/user/{user}"]!.get!;
    expect(userViewOp.parameters).toBeDefined();

    const userParams = userViewOp.parameters!.filter(
      (p: any) => p.name === "user",
    );
    // Should only appear once (as path param), not duplicated as query param
    expect(userParams.length).toBe(1);
    expect(userParams[0].in).toBe("path");
  });

  test("swagger includes securitySchemes for session cookie", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    expect(response.components.securitySchemes).toBeDefined();
    const scheme = response.components.securitySchemes!.sessionCookie;
    expect(scheme).toBeDefined();
    expect(scheme.type).toBe("apiKey");
    expect(scheme.in).toBe("cookie");
    expect(scheme.name).toBe("__session");
  });

  test("swagger includes document-level security requirement", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    expect(response.security).toBeDefined();
    expect(response.security).toEqual([{ sessionCookie: [] }]);
  });

  test("swagger endpoint itself is documented", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    expect(response.paths["/swagger"]).toBeDefined();
    expect(response.paths["/swagger"]!.get).toBeDefined();
    expect(response.paths["/swagger"]!.get!.operationId).toBe("swagger");
    expect(response.paths["/swagger"]!.get!.summary).toBe("swagger");
    expect(response.paths["/swagger"]!.get!.responses["200"]).toBeDefined();
  });

  test("swagger properly enumerates UserCreate action parameters", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Check the UserCreate action (PUT /user)
    const userCreatePath = response.paths["/user"]!.put!;

    expect(userCreatePath.requestBody).toBeDefined();
    const requestBody = userCreatePath.requestBody as any;
    expect(requestBody.required).toBe(true);
    expect(requestBody.content["application/json"]).toBeDefined();
    const schema = requestBody.content["application/json"].schema;
    expect(schema).toBeDefined();
    // Should be a $ref
    expect(typeof schema.$ref).toBe("string");
    const refName = schema.$ref.replace("#/components/schemas/", "");
    const resolved = response.components.schemas[refName];
    expect(resolved).toBeDefined();
    // Check that the schema is an object with properties
    expect(resolved.type).toBe("object");
    expect(resolved.properties).toBeDefined();
    // Check that all expected UserCreate parameters are present
    expect(resolved.properties.name).toBeDefined();
    expect(resolved.properties.email).toBeDefined();
    expect(resolved.properties.password).toBeDefined();
    // Check parameter types
    expect(resolved.properties.name.type).toBe("string");
    expect(resolved.properties.email.type).toBe("string");
    expect(resolved.properties.password.type).toBe("string");
    // Check required fields
    expect(resolved.required).toContain("name");
    expect(resolved.required).toContain("email");
    expect(resolved.required).toContain("password");
  });

  test("swagger documents response types from TypeScript return types", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Check the status action response schema
    const statusPath = response.paths["/status"]!.get!;
    expect(statusPath.responses["200"]).toBeDefined();
    const responseContent =
      statusPath.responses["200"]!.content["application/json"];
    expect(responseContent.schema).toBeDefined();

    // Should be a $ref to a response schema
    const schema = responseContent.schema;
    expect(schema.$ref).toBeDefined();
    const refName = schema.$ref.replace("#/components/schemas/", "");
    expect(refName).toBe("status_Response");

    // The response schema should exist in components
    const resolved = response.components.schemas[refName];
    expect(resolved).toBeDefined();
    expect(resolved.type).toBe("object");
    expect(resolved.properties).toBeDefined();

    // Check that the status response properties are present
    expect(resolved.properties.name).toBeDefined();
    expect(resolved.properties.pid).toBeDefined();
    expect(resolved.properties.version).toBeDefined();
    expect(resolved.properties.uptime).toBeDefined();
    expect(resolved.properties.consumedMemoryMB).toBeDefined();

    // Verify correct types are inferred (not generic objects)
    expect(resolved.properties.name.type).toBe("string");
    expect(resolved.properties.pid.type).toBe("number");
    expect(resolved.properties.version.type).toBe("string");
    expect(resolved.properties.uptime.type).toBe("number");
    expect(resolved.properties.consumedMemoryMB.type).toBe("number");

    // Ensure these are NOT incorrectly typed as objects with additionalProperties
    expect(resolved.properties.name.additionalProperties).toBeUndefined();
    expect(resolved.properties.pid.additionalProperties).toBeUndefined();

    // Check required fields
    expect(resolved.required).toContain("name");
    expect(resolved.required).toContain("pid");
    expect(resolved.required).toContain("version");
    expect(resolved.required).toContain("uptime");
    expect(resolved.required).toContain("consumedMemoryMB");
  });

  test("swagger documents response types for UserCreate action", async () => {
    const res = await fetch(getUrl() + "/api/swagger");
    const response = (await res.json()) as ActionResponse<Swagger>;

    // Check the user:create action response schema
    const userCreatePath = response.paths["/user"]!.put!;
    const responseContent =
      userCreatePath.responses["200"]!.content["application/json"];
    const schema = responseContent.schema;

    expect(schema.$ref).toBeDefined();
    const refName = schema.$ref.replace("#/components/schemas/", "");
    expect(refName).toBe("user_create_Response");

    // The response schema should have a user property
    const resolved = response.components.schemas[refName];
    expect(resolved).toBeDefined();
    expect(resolved.type).toBe("object");
    expect(resolved.properties.user).toBeDefined();
  });
});
