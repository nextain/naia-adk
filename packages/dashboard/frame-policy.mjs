/**
 * Tauri 2 창 출처는 Windows 기본 http://tauri.localhost(app.windows[].useHttpsScheme 를 켜면 https://tauri.localhost), Linux·macOS tauri://localhost.
 * naia-shell packages/shell/src-tauri/tauri.conf.json 에는 useHttpsScheme 가 없어 현재 Windows 출처는 http://tauri.localhost 이고,
 * naia-shell src-tauri/src/lib.rs 의 허용 출처 목록도 http://tauri.localhost,tauri://localhost 다.
 */
export const SHELL_FRAME_ORIGINS = Object.freeze([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
])

export const FRAME_ANCESTORS_CSP =
  "frame-ancestors 'self' http://tauri.localhost https://tauri.localhost tauri://localhost"
