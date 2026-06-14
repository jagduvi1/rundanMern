// Error plumbing — the MERN port of rundan's RuleViolationException +
// RuleViolationExceptionHandler (ProblemDetails). Thrown RuleViolations become
// `{ error: message }` with the given status; everything else is logged and
// returned as a generic 500 (message hidden in production).

class RuleViolation extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RuleViolation';
    this.status = status;
  }
}

// Wrap async route handlers so rejected promises reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFound = (req, res) => {
  res.status(404).json({ error: 'Route not found' });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // RuleViolation — user-facing, expected.
  if (err instanceof RuleViolation) {
    return res.status(err.status).json({ error: err.message });
  }
  // Mongoose validation → 400 with joined messages.
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: messages.join(', ') });
  }
  // Duplicate key (unique index) → 409 conflict.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'value';
    return res.status(409).json({ error: `That ${field} is already taken.` });
  }
  // Bad ObjectId / cast → 400.
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid id.' });
  }

  const status = err.status || err.statusCode || 500;
  // Log only what we control (avoid leaking req.body secrets into logs).
  console.error('[error]', {
    method: req.method,
    path: req.path,
    status,
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  const message =
    process.env.NODE_ENV === 'production' && status >= 500
      ? 'Internal server error'
      : err.message || 'Internal server error';
  res.status(status).json({ error: message });
};

module.exports = { RuleViolation, asyncHandler, notFound, errorHandler };
