import { realpath } from "node:fs/promises";
import path from "node:path";
import type { parse } from "node:url";
import { logger } from "../api";
import { config } from "../config";
import { getSecurityHeaders } from "./webResponse";

/**
 * Verify that the resolved on-disk path, with symlinks followed, stays
 * inside the static root. Returns the real base path + target path if
 * safe, or `null` if the target escapes (via symlink or otherwise).
 */
async function resolveWithinStaticRoot(
  targetPath: string,
  basePath: string,
): Promise<string | null> {
  try {
    const realBase = await realpath(basePath);
    const realTarget = await realpath(targetPath);
    if (
      realTarget !== realBase &&
      !realTarget.startsWith(realBase + path.sep)
    ) {
      return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * Attempt to serve a static file for the given request. Returns a `Response`
 * if a matching file is found, or `null` to let other handlers deal with it.
 */
export async function handleStaticFile(
  req: Request,
  url: ReturnType<typeof parse>,
): Promise<Response | null> {
  const staticRoute = config.server.web.staticFiles.route;
  const staticDir = config.server.web.staticFiles.directory;

  if (!url.pathname?.startsWith(staticRoute)) {
    return null;
  }

  const filePath = url.pathname.replace(staticRoute, "");

  // Default to index.html for root requests
  const finalPath =
    filePath === "" || filePath === "/" ? "/index.html" : filePath;

  try {
    // Construct the full file path, ensuring proper path joining
    const fullPath = path.resolve(path.join(staticDir, finalPath));
    const basePath = path.resolve(staticDir);

    // Prevent path traversal attacks (e.g. symlinks or encoded sequences)
    if (!fullPath.startsWith(basePath + path.sep) && fullPath !== basePath) {
      return null;
    }

    // Check if file exists
    const file = Bun.file(fullPath);
    const exists = await file.exists();

    if (!exists) {
      // Try serving index.html for directory requests
      if (!finalPath.endsWith(".html")) {
        const indexPath = path.resolve(
          path.join(staticDir, finalPath, "index.html"),
        );
        if (
          !indexPath.startsWith(basePath + path.sep) &&
          indexPath !== basePath
        ) {
          return null;
        }
        const indexFile = Bun.file(indexPath);
        const indexExists = await indexFile.exists();
        if (indexExists) {
          if ((await resolveWithinStaticRoot(indexPath, basePath)) === null) {
            return null;
          }
          return buildStaticFileResponse(
            req,
            indexFile,
            finalPath + "/index.html",
          );
        }
      }
      return null; // File not found, let other handlers deal with it
    }

    // Follow symlinks and confirm the real path stays inside staticDir —
    // prevents symlinks inside staticDir from serving files outside it.
    if ((await resolveWithinStaticRoot(fullPath, basePath)) === null) {
      return null;
    }

    return buildStaticFileResponse(req, file, finalPath);
  } catch (error) {
    logger.error(`Error serving static file ${finalPath}: ${error}`);
    return null;
  }
}

async function buildStaticFileResponse(
  req: Request,
  file: ReturnType<typeof Bun.file>,
  filePath: string,
): Promise<Response> {
  const headers = getStaticFileHeaders(filePath);

  // Generate ETag from mtime + size (fast, no hashing needed)
  if (config.server.web.staticFiles.etag) {
    const mtime = file.lastModified;
    const size = file.size;
    const etag = `"${mtime.toString(36)}-${size.toString(36)}"`;
    headers["ETag"] = etag;
    headers["Last-Modified"] = new Date(mtime).toUTCString();

    // Check If-None-Match (takes precedence over If-Modified-Since per HTTP spec)
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers });
    }

    // Check If-Modified-Since
    const ifModifiedSince = req.headers.get("if-modified-since");
    if (ifModifiedSince) {
      const ifModifiedSinceDate = new Date(ifModifiedSince).getTime();
      // File mtime is in ms; compare at second precision (HTTP dates are second-precision)
      if (
        !isNaN(ifModifiedSinceDate) &&
        Math.floor(mtime / 1000) <= Math.floor(ifModifiedSinceDate / 1000)
      ) {
        return new Response(null, { status: 304, headers });
      }
    }
  }

  // Add Cache-Control
  if (config.server.web.staticFiles.cacheControl) {
    headers["Cache-Control"] = config.server.web.staticFiles.cacheControl;
  }

  return new Response(file, { headers });
}

function getStaticFileHeaders(filePath: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-SERVER-NAME": config.process.name,
  };

  const mimeType = Bun.file(filePath).type || "application/octet-stream";
  headers["Content-Type"] = mimeType;
  Object.assign(headers, getSecurityHeaders());

  return headers;
}
