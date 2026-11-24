// AX messenger gateway error code -> localized `ax.err.*` key mapping.
// Kept outside `page.tsx`: Next.js pages may only export the default
// component (plus `metadata` and friends).
import { tFor } from "../../i18n/index.ts"
import type { Locale, TranslationKey } from "../../i18n/types.ts"

/** Gateway `code` -> localized `ax.err.*` key. Unknown codes fall back to the server message. */
export const ERROR_CODE_KEYS: Record<string, TranslationKey> = {
  "bad-request": "ax.err.badRequest",
  "invalid-input": "ax.err.badRequest",
  "matrix-auth": "ax.err.matrixAuth",
  auth: "ax.err.loginRequired",
  "no-permission": "ax.err.noPermission",
  forbidden: "ax.err.noPermission",
  duplicate: "ax.err.duplicate",
  "user-in-use": "ax.err.userInUse",
  "too-large": "ax.err.tooLarge",
  "too_large": "ax.err.tooLarge",
  "rate-limited": "ax.err.rateLimited",
  "rate_limited": "ax.err.rateLimited",
  server: "ax.err.server",
  unknown: "ax.err.server",
  "matrix-conn": "ax.err.matrixConn",
  network: "ax.err.matrixConn",
  "login-required": "ax.err.loginRequired",
  "room-denied": "ax.err.roomDenied",
  "message-required": "ax.err.messageRequired",
  "route-not-found": "ax.err.routeNotFound",
  "service-stopped": "ax.err.serviceStopped",
  "config-error": "ax.err.configError",
  "messenger-off": "ax.err.messengerOff",
  "origin-not-allowed": "ax.err.originNotAllowed",
  "account-mismatch": "ax.err.accountMismatch",
  "permission-changed": "ax.err.permissionChanged",
  "admin-disabled": "ax.err.adminDisabled",
}

export { ERROR_CODE_KEYS as AX_ERROR_CODE_KEYS }

export class MessengerRequestError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

export function axErrorMessage(
  err: unknown,
  t: (key: TranslationKey) => string,
  fallbackKey: TranslationKey,
): string {
  if (err instanceof MessengerRequestError && err.code && ERROR_CODE_KEYS[err.code]) {
    return t(ERROR_CODE_KEYS[err.code])
  }
  if (err instanceof Error && err.message) return err.message
  return t(fallbackKey)
}

/** Locale-bound translator for AX error codes (pure helper for views). */
export function axErrorMessageForLocale(err: unknown, locale: Locale, fallbackKey: TranslationKey): string {
  return axErrorMessage(err, tFor(locale), fallbackKey)
}
