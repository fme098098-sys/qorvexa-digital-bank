'use strict';
/** An error whose message is safe to show to the end user. */
class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
module.exports = { AppError };
