import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { isApiRequest, unexpectedRequestErrorResponse } from "./server/http.server";

const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(isApiRequest(request) ? "api_request_failed" : error);
    return unexpectedRequestErrorResponse(request);
  }
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
  ...(process.env.HDEX_PUBLIC_ORIGIN ? { origin: process.env.HDEX_PUBLIC_ORIGIN } : {}),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, errorMiddleware],
}));
