export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist.' } });
}

export function errorHandler(error, req, res, _next) {
  if (res.headersSent) return;
  if (error?.name === 'ZodError') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Please check the submitted fields.', details: error.issues?.map(issue => ({ path: issue.path, message: issue.message })) } });
  }
  if (error instanceof HttpError) {
    const body = { code: error.code, message: error.message };
    if (error.details !== undefined) body.details = error.details;
    return res.status(error.status).json({ error: body });
  }
  // Do not expose SQL, provider responses, access tokens, or environment values.
  console.error(JSON.stringify({ level: 'error', service: process.env.SERVICE_NAME || 'vine-api', requestId: req.id, message: error?.message || 'Unknown error' }));
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}
