export class AppError extends Error {
  constructor(status,code,message) { super(message); this.status=status; this.code=code; }
}
export function requireValue(condition, message, code='INVALID_INPUT') {
  if (!condition) throw new AppError(400,code,message);
}
