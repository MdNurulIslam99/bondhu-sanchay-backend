export class AppError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const notFound = (message = 'Record not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT', fields) => new AppError(409, code, message, fields);
export const invalid = (fields, message = 'Please check the submitted fields.') => new AppError(422, 'VALIDATION_ERROR', message, fields);
export const forbidden = (message = 'Permission denied', code = 'FORBIDDEN') => new AppError(403, code, message);
export const unauthenticated = (message = 'Please sign in') => new AppError(401, 'UNAUTHENTICATED', message);

// Friendly names for the unique indexes that users can run into.
const duplicateMessages = {
  email: 'This email is already used by another account.',
  phone: 'This mobile number is already in use.',
  trxKey: 'This transaction ID has already been submitted.',
  memberId: 'This member already has a verified deposit for this month.',
  accountId: 'This account already has a record for this month.',
  nameKey: 'A record with this name already exists.',
  slug: 'This slug is already in use.',
  sl: 'This serial number is already in use.',
};

/** One error shape for both frontends: `message` + `errors` (admin) and `error` (website). */
export function errorBody(status, code, message, fields) {
  return {
    success: false,
    message,
    errors: fields || {},
    error: { code, message, ...(fields ? { fields } : {}) },
  };
}

export function routeNotFound(req, res) {
  res.status(404).json(errorBody(404, 'NOT_FOUND', 'Route not found'));
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.code === 11000) {
    const key = Object.keys(err.keyPattern || {})[0];
    err = conflict(duplicateMessages[key] || 'A record with these details already exists.', 'DUPLICATE_RECORD',
      key ? { [key]: 'Already in use' } : undefined);
  } else if (err.name === 'MulterError') {
    err = invalid({ file: err.code === 'LIMIT_FILE_SIZE' ? 'The image must be 5 MB or smaller' : err.message });
  }
  const candidate = err.statusCode || err.status;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  if (status >= 500 && !(err instanceof AppError)) console.error(err);
  const known = err instanceof AppError;
  const code = known ? err.code : status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  const message = known ? err.message : status >= 500 ? 'Something went wrong. Please try again.' : err.message;
  res.status(status).json(errorBody(status, code, message, known ? err.fields : undefined));
}
