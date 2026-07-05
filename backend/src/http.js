export function ok(data, message = "ok") {
  return { success: true, data, message };
}

export function fail(res, status, errorCode, message) {
  return res.status(status).json({
    success: false,
    data: null,
    message,
    error_code: errorCode
  });
}

export class AppError extends Error {
  constructor(status, errorCode, message) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
