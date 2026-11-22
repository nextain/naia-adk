// 직접 길 출입구. 화면·naia-shell·휴대폰 앱이 가져가는 읽기·보내기만 둔다.
// 관리 길(발급·방 만들기·초대·표시 이름·사용량)은 "@naia-adk/ax-messenger/admin"에서만 난다.
export { AxMessengerClient, messageFromEvent, normalizeSession } from "./client.js"
export type { AxClientDeps } from "./client.js"
export type { MatrixClient } from "./client.js"
export {
  AxMessengerError,
  httpStatusOfAxError,
  invalidInput,
  isAxMessengerError,
  sanitizeForLog,
  toAxError,
  userMessageOf,
} from "./errors.js"
export type { AxErrorKind } from "./errors.js"
export type {
  AxChatMessage,
  AxFile,
  AxParticipant,
  AxRoomSummary,
  AxSession,
  AxTextOptions,
} from "./types.js"
