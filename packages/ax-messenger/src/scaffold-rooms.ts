// 뼈대 세우기 대상 방 판별. 뒤쪽 서버 전용이며 화면 묶음은 가져가지 않는다.
// 방 식별자 목록(AX_SCAFFOLD_ROOM_IDS)만 쓴다. 이름 일부 일치는 쓰지 않는다.
// 목록이 비어 있으면 어떤 방도 대상이 아니다(봇은 목록 없이 시작하지 않는다).
export function parseScaffoldRoomIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

// 목록에 든 방 식별자일 때만 대상이다. 초대받은 방이 목록에 없으면 봇은
// 그 방에 입장하지 않는다.
export function isScaffoldRoom(roomId: string, allowlist: string[]): boolean {
  const id = (roomId ?? "").trim()
  if (!id) return false
  return allowlist.includes(id)
}
