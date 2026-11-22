// 넥스테인 AI 봇 단일 실행 잠금. 뒤쪽 서버 전용이며 화면 묶음은 가져가지 않는다.
// 같은 이름 공간 안에서 같은 기관 표지의 봇 이중 기동을 일찍 알리는 보조다.
// 한도·중복의 정확성은 이 잠금에 기대지 않고 공유 원장(ai-ledger.sqlite)의
// 원자 예약에 기댄다. 같은 데이터 폴더를 쓰는 봇은 몇 개든 원장으로 함께 지킨다.
// 수단이 하나뿐이다: 리눅스 추상 유닉스 소켓에 서버를 묶는다. 이름이 이미
// 묶여 있으면(EADDRINUSE) 둘째 봇은 시작 오류로 끝난다. 프로세스가 죽으면
// 운영체제가 이름을 자동으로 푼다.
// 회수 코드·파일 잠금은 없다. 파일 잠금과 죽은 잠금 회수(rename·link·unlink·
// 내용 비교)는 세 회차 연속 경합 지적을 받은 방식이라 고쳐 쓰지 않고 버렸다.
import { createHash } from "node:crypto"
import net from "node:net"

export type AxBotLock = {
  // 소켓 서버를 닫는 해제만 가진다. 받는 쪽 연결은 없다.
  release(): Promise<void>
}

export type AxBotLockDeps = {
  // 시험에서 운영체제를 가장할 때 쓴다. 기본값은 process.platform이다.
  // "linux"가 아니면 시작 오류다. 조용히 잠금 없이 도는 갈래는 없다.
  platform?: string
}

// 기관 표지를 추상 소켓 이름에 그대로 넣지 않는다. 못 쓰는 글자·108바이트
// 한도를 피하려고 sha256 앞 16자(hex)로 정규화했다. 추상 이름은 항상
// "\0ax-ai-bot-<16hex>"(앞의 0 바이트까지 27바이트)라 한도 안에 든다.
export function axBotSocketNameFor(orgId: string): string {
  const id = (orgId ?? "").trim()
  if (!id) throw new Error("기관 식별자 설정(AX_ORG_ID)이 없어 넥스테인 AI 봇을 시작하지 않습니다.")
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)
  return `\0ax-ai-bot-${digest}`
}

// 기관 표지의 봇 잠금을 잡는다. 같은 표지가 이미 묶여 있으면 시작 오류다.
// 리눅스가 아니면 시작 오류다. 옛 잠금 파일 경로 설정·파일이 남아 있어도
// 읽지도 지우지도 않는다(무시). 서버는 unref하지 않는다(살아 있는 동안 잡고
// 있게). 해제는 봇 종료 처리에 묶는다(ai-bot.mjs의 finally).
export async function acquireAxBotLock(orgId: string, deps?: AxBotLockDeps): Promise<AxBotLock> {
  const platform = deps?.platform ?? process.platform
  if (platform !== "linux") {
    throw new Error("넥스테인 AI 봇 단일 실행 잠금은 리눅스에서만 돕니다. 잠금 없이 시작하지 않습니다.")
  }
  const socketName = axBotSocketNameFor(orgId)
  const server = net.createServer((socket) => {
    // 잠금 소켓으로 들어오는 연결은 바로 끊는다.
    socket.destroy()
  })
  // 묶은 뒤의 stray 오류는 프로세스를 떨어뜨리지 않게 버린다.
  server.on("error", () => undefined)
  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: unknown) => {
      server.off("error", onListenError)
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "EADDRINUSE") {
        reject(new Error("넥스테인 AI 봇이 이미 실행 중입니다. 둘째 봇은 시작하지 않습니다."))
      } else {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    server.once("error", onListenError)
    server.listen({ path: socketName }, () => {
      server.off("error", onListenError)
      resolve()
    })
  })
  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
