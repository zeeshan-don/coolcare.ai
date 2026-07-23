// api/_lib/errors.js
// Centralized error handling for all API endpoints.
// Never expose internal errors to clients.

/**
 * Wrap an async handler with error catching.
 * Catches all unhandled errors and returns a safe 500 response.
 */
function withErrorHandler(handler) {
  return async (request, response) => {
    try {
      return await handler(request, response);
    } catch (error) {
      // Log full error server-side for debugging
      console.error(`[${request.url}] Unhandled error:`, {
        message: error.message,
        code: error.code,
        stack: error.stack?.split("\n").slice(0, 3).join("\n"),
      });

      // Never expose internal error details to client
      const statusCode = error.statusCode || 500;
      const message =
        statusCode < 500
          ? error.message
          : "An unexpected error occurred. Please try again.";

      return response.status(statusCode).json({ error: message });
    }
  };
}

/**
 * Create a typed API error with a status code.
 */
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "ApiError";
  }
}

// Common error factories
const errors = {
  badRequest: (msg = "Bad request") => new ApiError(400, msg),
  unauthorized: (msg = "Authentication required") => new ApiError(401, msg),
  forbidden: (msg = "Access denied") => new ApiError(403, msg),
  notFound: (msg = "Resource not found") => new ApiError(404, msg),
  conflict: (msg = "Resource already exists") => new ApiError(409, msg),
  tooMany: (msg = "Too many requests") => new ApiError(429, msg),
  internal: (msg = "Internal server error") => new ApiError(500, msg),
  serviceUnavailable: (msg = "Service temporarily unavailable") =>
    new ApiError(503, msg),
};

/**
 * Method guard — only allow specific HTTP methods.
 */
function allowMethods(request, response, ...methods) {
  if (!methods.includes(request.method)) {
    response.setHeader("Allow", methods.join(", "));
    response.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}

module.exports = { withErrorHandler, ApiError, errors, allowMethods };
