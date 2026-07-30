import Mustache from "mustache";
import type { z } from "zod";
import type { Action } from "../classes/Action";
import { escapeHtml } from "./oauth";
import { DEFAULT_THEME_CSS, resolveThemeCss } from "./theme";
import { isSecret } from "./zodMixins";

export type FormField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  minlength?: number;
  maxlength?: number;
};

export type OAuthTemplates = {
  authTemplate: string;
  commonCss: string;
  lionSvg: string;
  /** App's shared theme CSS, inlined after {@link commonCss} so its overrides win. */
  themeCss: string;
};

const frameworkTemplatesDir = import.meta.dir + "/../templates";

/**
 * Resolve a template file, checking the user's rootDir first, then falling back
 * to the framework's built-in templates.
 * @param filename - Template filename (e.g., "oauth-authorize.html").
 * @param rootDir - The user app's root directory.
 * @param packageDir - The framework package directory.
 * @returns The template file contents as a string.
 */
async function resolveTemplate(
  filename: string,
  rootDir: string,
  packageDir: string,
): Promise<string> {
  if (rootDir !== packageDir) {
    const userFile = Bun.file(`${rootDir}/templates/${filename}`);
    if (await userFile.exists()) return userFile.text();
  }
  return Bun.file(`${frameworkTemplatesDir}/${filename}`).text();
}

/**
 * Load the OAuth template files, resolving from user project first, then framework.
 * @param rootDir - The user app's root directory.
 * @param packageDir - The framework package directory.
 * @returns An object containing all template strings.
 */
export async function loadOAuthTemplates(
  rootDir: string,
  packageDir: string,
): Promise<OAuthTemplates> {
  const [authTemplate, commonCss, lionSvg, themeCss] = await Promise.all([
    resolveTemplate("oauth-authorize.html", rootDir, packageDir),
    resolveTemplate("oauth-common.css", rootDir, packageDir),
    resolveTemplate("lion.svg", rootDir, packageDir),
    resolveThemeCss(),
  ]);
  return { authTemplate, commonCss, lionSvg, themeCss };
}

/**
 * Introspect a Zod object schema from an action and return a Mustache-friendly
 * array of form field descriptors.
 * @param action - The action whose `inputs` schema to introspect.
 * @returns Array of {@link FormField} objects for template rendering.
 */
export function zodToFormFields(action: Action | undefined): FormField[] {
  if (!action?.inputs) return [];
  const zodSchema = action.inputs as z.ZodObject<any>;
  if (!zodSchema.shape) return [];

  const fields: FormField[] = [];
  for (const [fieldName, fieldSchema] of Object.entries(zodSchema.shape)) {
    const schema = fieldSchema as z.ZodType;

    // Determine HTML input type
    let type = "text";
    if (isSecret(schema)) {
      type = "password";
    } else if (fieldName.toLowerCase().includes("email")) {
      type = "email";
    }

    // Extract label from .describe() or humanize the field name
    const description = (schema as any).description as string | undefined;
    const label = description
      ? description.charAt(0).toUpperCase() + description.slice(1)
      : fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

    // Best-effort min/max extraction from Zod v4 internals
    let minlength: number | undefined;
    let maxlength: number | undefined;
    try {
      const def = (schema as any)._zod?.def;
      if (def?.checks) {
        for (const check of def.checks) {
          if (check.kind === "min" && typeof check.value === "number") {
            minlength = check.value;
          }
          if (check.kind === "max" && typeof check.value === "number") {
            maxlength = check.value;
          }
        }
      }
    } catch {
      // Silently ignore if Zod internals change
    }

    fields.push({
      name: fieldName,
      label,
      type,
      required: !(schema as any).isOptional?.(),
      ...(minlength !== undefined && { minlength }),
      ...(maxlength !== undefined && { maxlength }),
    });
  }

  return fields;
}

/**
 * Pre-render an array of form fields into HTML strings.
 * This avoids Mustache conditionals inside HTML tags (which breaks formatters).
 * @param fields - Array of {@link FormField} objects.
 * @param prefix - ID prefix for field elements (e.g., "signin" or "signup").
 * @returns HTML string with label + input pairs.
 */
export function renderFormFieldsHtml(
  fields: FormField[],
  prefix: string,
): string {
  return fields
    .map((f) => {
      const attrs = [
        `type="${escapeHtml(f.type)}"`,
        `id="${prefix}-${escapeHtml(f.name)}"`,
        `name="${escapeHtml(f.name)}"`,
      ];
      if (f.required) attrs.push("required");
      if (f.minlength !== undefined)
        attrs.push(`minlength="${String(f.minlength)}"`);
      if (f.maxlength !== undefined)
        attrs.push(`maxlength="${String(f.maxlength)}"`);

      return `<label for="${prefix}-${escapeHtml(f.name)}">${escapeHtml(f.label)}</label>\n          <input ${attrs.join(" ")} />`;
    })
    .join("\n          ");
}

export type AuthPageParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  state: string;
  error: string;
  /**
   * Display name of the requesting client, when it could be resolved. Shown on
   * the consent form so the user can tell who is asking — required when the
   * client identified itself with a Client ID Metadata Document, since such a
   * client is self-asserted rather than pre-registered.
   */
  clientName?: string;
};

/** Loopback hosts that warrant an extra warning on the consent form. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Render the "who is asking" block above the sign-in form.
 *
 * The redirect URI's hostname is always shown: it is where the authorization
 * code will be delivered, and is the only part of the request a user can
 * meaningfully judge. Loopback redirects get an explicit warning because a
 * Client ID Metadata Document cannot prove that a `localhost` callback belongs
 * to the app it names (MCP 2026-07-28 authorization security considerations,
 * "Localhost Redirect URI Risks").
 *
 * @param params - The OAuth parameters for the page.
 * @returns An HTML fragment, or `""` when there is nothing meaningful to show.
 */
function renderClientInfoHtml(params: AuthPageParams): string {
  let host = "";
  try {
    const redirect = new URL(params.redirectUri);
    // A private-use scheme (e.g. `com.example.app:/callback`) has no host, so
    // fall back to the scheme — it is still the identifying part of the target.
    host = redirect.host || redirect.protocol;
  } catch {
    host = "";
  }
  if (!params.clientName && !host) return "";

  const rows: string[] = [];
  if (params.clientName) {
    rows.push(
      `<p><strong>${escapeHtml(params.clientName)}</strong> is requesting access to your account.</p>`,
    );
  }
  if (host) {
    rows.push(
      `<p class="client-detail">Redirects to <strong>${escapeHtml(host)}</strong></p>`,
    );
    const hostname = host.split(":")[0] ?? "";
    if (LOOPBACK_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(host)) {
      rows.push(
        `<p class="client-warning">This will send your authorization to an application running on this machine. Continue only if you started this sign-in yourself.</p>`,
      );
    }
  }

  return `<div class="client-info">${rows.join("")}</div>`;
}

/**
 * Render the OAuth authorization page with dynamic form fields.
 * @param params - OAuth parameters for the page (client ID, redirect URI, error, etc.).
 * @param templates - Loaded OAuth template strings.
 * @param actions - Object containing the login and signup actions (if any).
 * @returns An HTML Response.
 */
export function renderAuthPage(
  params: AuthPageParams,
  templates: OAuthTemplates,
  actions: { loginAction?: Action; signupAction?: Action },
): Response {
  const errorHtml = params.error
    ? `<div class="error">${escapeHtml(params.error)}</div>`
    : "";

  const hiddenFields = `
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
    <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
  `;

  const signinFields = zodToFormFields(actions.loginAction);
  const signupFields = zodToFormFields(actions.signupAction);
  const hasSignin = signinFields.length > 0;
  const hasSignup = signupFields.length > 0;
  const signinFieldsHtml = renderFormFieldsHtml(signinFields, "signin");
  const signupFieldsHtml = renderFormFieldsHtml(signupFields, "signup");

  const html = Mustache.render(
    templates.authTemplate,
    {
      errorHtml,
      clientInfoHtml: renderClientInfoHtml(params),
      hiddenFields,
      hasSignin,
      hasSignup,
      signinFieldsHtml,
      signupFieldsHtml,
    },
    {
      defaultThemeCss: DEFAULT_THEME_CSS,
      commonCss: templates.commonCss,
      lionSvg: templates.lionSvg,
      themeCss: templates.themeCss,
    },
  );

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
