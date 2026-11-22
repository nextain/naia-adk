import {
  ClientEvent,
  createClient,
  EventType,
  MatrixEvent,
  MsgType,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk"
import { AxMessengerError, invalidInput, isAxMessengerError, toAxError } from "./errors.js"
import type { AxChatMessage, AxFile, AxParticipant, AxRoomSummary, AxSession, AxTextOptions } from "./types.js"

type ClientLogger = NonNullable<Parameters<typeof createClient>[0]["logger"]>
const silentLogger: ClientLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() { return silentLogger },
}

// 단위 시험용 주입 자리. 화면은 앞 인자만 쓴다.
export type AxClientDeps = {
  createClient?: typeof createClient
}

export function normalizeSession(session: AxSession): AxSession {
  if (!session?.homeserverUrl || !session?.userId || !session?.accessToken) {
    throw invalidInput("저장된 연결 정보를 읽지 못했습니다. 다시 로그인해 주세요.")
  }
  return { ...session, homeserverUrl: session.homeserverUrl.replace(/\/$/, "") }
}

export function messageFromEvent(event: MatrixEvent, roomId: string): AxChatMessage | null {
  const content = event.getContent()
  if (event.getType() !== EventType.RoomMessage || typeof content?.body !== "string") return null
  const replyId = event.replyEventId
  const mentions = content["m.mentions"]?.user_ids
  // 인용 fallback은 원문 증거가 아니다. 관계가 있을 때만 표준 접두부를 제거한다.
  const body = replyId ? content.body.replace(/^(?:> [^\n]*(?:\n|$))+\n?/, "") : content.body
  return {
    eventId: event.getId() ?? `${event.getTs()}-${event.getSender()}`,
    roomId,
    sender: event.getSender() ?? "",
    body,
    timestamp: event.getTs(),
    messageType: content.msgtype ?? "m.text",
    mediaUrl: content.url,
    mimeType: content.info?.mimetype,
    size: content.info?.size,
    ...(typeof replyId === "string" && replyId ? { replyToEventId: replyId } : {}),
    ...(Array.isArray(mentions) && mentions.every((id: unknown) => typeof id === "string")
      ? { mentionUserIds: [...mentions] as string[] } : {}),
  }
}

// 직접 길. 화면이 부르는 읽기·보내기만 둔다. 발급·방 만들기·초대는 admin 출입구 몫이다.
export class AxMessengerClient {
  private generation = 0
  private readonly messageListeners: Array<(event: MatrixEvent) => void> = []
  private readonly syncListeners: Array<() => void> = []

  private constructor(
    readonly session: AxSession,
    private readonly matrix: MatrixClient,
  ) {}

  // FE-ax1-02-01 로그인
  static async login(
    homeserverUrl: string,
    user: string,
    password: string,
    deps?: AxClientDeps,
  ): Promise<AxMessengerClient> {
    const baseUrl = (homeserverUrl ?? "").trim().replace(/\/$/, "")
    if (!baseUrl || !user?.trim() || !password) {
      throw invalidInput("서버 주소·아이디·비밀번호를 확인해 주세요.")
    }
    const makeClient = deps?.createClient ?? createClient
    try {
      const unauthenticated = makeClient({ baseUrl, logger: silentLogger })
      let result: { user_id: string; access_token: string; device_id?: string }
      try {
        result = await unauthenticated.login("m.login.password", { user: user.trim(), password })
      } finally {
        // 일회성 로그인 연결 정리. 가짜 클라이언트에는 stopClient가 없을 수 있다.
        try { (unauthenticated as unknown as { stopClient?: () => void }).stopClient?.() } catch { /* 정리만 */ }
      }
      const session = {
        homeserverUrl: baseUrl,
        userId: result.user_id,
        accessToken: result.access_token,
        deviceId: result.device_id,
      }
      if (deps?.createClient) {
        const matrix = makeClient({
          baseUrl: session.homeserverUrl,
          logger: silentLogger,
          accessToken: session.accessToken,
          userId: session.userId,
          deviceId: session.deviceId,
        })
        return AxMessengerClient.fromSession(session, matrix)
      }
      return AxMessengerClient.fromSession(session)
    } catch (error) {
      if (isAxMessengerError(error)) throw error
      // 로그인 실패는 서버가 403·M_FORBIDDEN으로 내려도 인증 실패이므로 auth로 되돌린다.
      const axError = toAxError(error, "아이디나 비밀번호를 확인해 주세요.")
      if (axError.kind === "forbidden") {
        throw new AxMessengerError({
          kind: "auth",
          userMessage: axError.userMessage,
          detail: axError.detail,
          status: axError.status,
          errcode: axError.errcode,
        })
      }
      throw axError
    }
  }

  // FE-ax1-02-02 다시 연결. 세션만으로 이어 붙이며 망을 부르지 않는다.
  static fromSession(session: AxSession, injected?: MatrixClient): AxMessengerClient {
    const normalized = normalizeSession(session)
    if (injected) return new AxMessengerClient(normalized, injected)
    const matrix = createClient({
      baseUrl: normalized.homeserverUrl,
      logger: silentLogger,
      accessToken: normalized.accessToken,
      userId: normalized.userId,
      deviceId: normalized.deviceId,
    })
    return new AxMessengerClient(normalized, matrix)
  }

  // FE-ax1-02-03 실시간 갱신 시작·끝
  start(
    onMessage?: (message: AxChatMessage) => void,
    onRoomsChanged?: () => void,
  ): Promise<void> {
    const generation = this.generation
    if (onMessage) {
      const listener = (event: MatrixEvent) => {
        if (generation !== this.generation) return
        const roomId = event.getRoomId()
        if (!roomId) return
        if (this.matrix.getRoom(roomId)?.getMyMembership() !== "join") return
        const message = messageFromEvent(event, roomId)
        if (message) onMessage(message)
      }
      this.messageListeners.push(listener)
      this.matrix.on(ClientEvent.Event, listener)
    }
    const listener = () => {
      if (generation !== this.generation) return
      void this.acceptInvites().then(() => {
        if (generation === this.generation) onRoomsChanged?.()
      })
    }
    this.syncListeners.push(listener)
    this.matrix.on(ClientEvent.Sync, listener)
    return this.matrix.startClient({ initialSyncLimit: 30 }).catch((error: unknown) => {
      throw toAxError(error, "실시간 연결을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    })
  }

  stop(): void {
    this.generation += 1
    for (const listener of this.messageListeners.splice(0)) this.matrix.off(ClientEvent.Event, listener)
    for (const listener of this.syncListeners.splice(0)) this.matrix.off(ClientEvent.Sync, listener)
    this.matrix.stopClient()
  }

  // FE-ax1-02-04 방 목록·대화·참가자 읽기. 읽기는 망 실패를 내지 않고 빈 값을 돌려준다.
  listRooms(): AxRoomSummary[] {
    return this.matrix.getRooms()
      .filter((room) => room.getMyMembership() === "join")
      .map((room) => this.roomSummary(room))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  getMessages(roomId: string): AxChatMessage[] {
    if (!roomId) return []
    const room = this.matrix.getRoom(roomId)
    if (!room || room.getMyMembership() !== "join") return []
    return room.getLiveTimeline().getEvents()
      .map((event) => messageFromEvent(event, roomId))
      .filter((message): message is AxChatMessage => message !== null)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  listParticipants(roomId: string): AxParticipant[] {
    if (!roomId) return []
    const room = this.matrix.getRoom(roomId)
    if (!room || room.getMyMembership() !== "join") return []
    return room.getMembers().map((member) => ({
      userId: member.userId,
      displayName: member.name || member.userId,
      membership: member.membership ?? "leave",
    }))
  }

  // FE-ax1-02-05 보내기. 429·413 갈래는 kind로 구분해 돌려준다.
  async sendText(roomId: string, body: string, options?: AxTextOptions): Promise<void> {
    const text = (body ?? "").trim()
    if (!roomId) throw invalidInput("대화방을 선택해 주세요.")
    if (!text) throw invalidInput("메시지를 입력해 주세요.")
    const mentionIds = options?.mentionUserIds
    if (mentionIds !== undefined && (!Array.isArray(mentionIds) ||
      !mentionIds.every((id) => typeof id === "string" && /^@[^\s:]+:[^\s]+$/.test(id)))) {
      throw invalidInput("멘션할 사용자 아이디를 확인해 주세요.")
    }
    const replyId = options?.replyToEventId
    try {
      let replyEvent: MatrixEvent | undefined
      if (replyId !== undefined) {
        const room = this.matrix.getRoom(roomId)
        if (typeof replyId !== "string" || !/^\$\S+$/.test(replyId) || room?.getMyMembership() !== "join") {
          throw invalidInput("답할 원문을 확인해 주세요.")
        }
        const generation = this.generation
        replyEvent = room.getLiveTimeline().getEvents().find((event) => event.getId() === replyId)
        if (!replyEvent) {
          replyEvent = new MatrixEvent(await this.matrix.fetchRoomEvent(roomId, replyId))
        }
        if (generation !== this.generation || this.matrix.getRoom(roomId)?.getMyMembership() !== "join" ||
          replyEvent.getRoomId() !== roomId || replyEvent.getId() !== replyId || replyEvent.isRedacted() ||
          !messageFromEvent(replyEvent, roomId) || !replyEvent.getSender()) {
          throw invalidInput("답할 원문을 확인해 주세요.")
        }
      }
      if (replyId || mentionIds?.length) {
        const original = replyEvent && messageFromEvent(replyEvent, roomId)
        const quoted = original?.body.replace(/\r\n?/g, "\n").split("\n")
        const replyBody = quoted && replyEvent
          ? `> <${replyEvent.getSender()}> ${quoted.join("\n> ")}\n\n${text}`
          : text
        await this.matrix.sendMessage(roomId, {
          msgtype: MsgType.Text,
          body: replyBody,
          "m.mentions": mentionIds?.length ? { user_ids: [...new Set(mentionIds)] } : {},
          ...(replyId ? { "m.relates_to": { "m.in_reply_to": { event_id: replyId } } } : {}),
        })
      } else {
        await this.matrix.sendTextMessage(roomId, text)
      }
    } catch (error) {
      if (isAxMessengerError(error)) throw error
      throw toAxError(error, "메시지를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    }
  }

  // FE-ax1-02-06 파일 올리기. 크기·빈도 한도 거부는 kind로 구분된다. 한도 값은 [확인 필요].
  async sendFile(roomId: string, file: AxFile): Promise<void> {
    if (!roomId) throw invalidInput("대화방을 선택해 주세요.")
    if (!file?.name?.trim() || !file?.data) throw invalidInput("파일을 선택해 주세요.")
    try {
      const uploaded = await this.matrix.uploadContent(file.data, {
        name: file.name,
        type: file.mimeType,
        includeFilename: true,
      })
      const isImage = (file.mimeType ?? "").startsWith("image/")
      await this.matrix.sendEvent(roomId, EventType.RoomMessage, {
        msgtype: isImage ? MsgType.Image : MsgType.File,
        body: file.name,
        filename: file.name,
        url: uploaded.content_uri,
        info: { mimetype: file.mimeType, size: file.size },
      } as never)
    } catch (error) {
      if (isAxMessengerError(error)) throw error
      throw toAxError(error, "파일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    }
  }

  mediaHttpUrl(mxcUrl: string): string | null {
    return this.matrix.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, false, true)
  }

  // FE-ax1-02-06 파일 내려받기
  async downloadMedia(mxcUrl: string): Promise<Blob> {
    if (!mxcUrl?.startsWith("mxc://")) throw invalidInput("파일 주소를 해석할 수 없습니다.")
    const url = this.mediaHttpUrl(mxcUrl)
    if (!url) throw invalidInput("파일 주소를 해석할 수 없습니다.")
    let response: Response
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.session.accessToken}` } })
    } catch (error) {
      throw toAxError(error, "파일을 내려받지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    }
    if (!response.ok) {
      throw toAxError(
        { httpStatus: response.status, message: `media download ${response.status}` },
        response.status === 401 || response.status === 403
          ? "파일을 볼 권한을 확인해 주세요. 다시 로그인해 주세요."
          : "파일을 내려받지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
      )
    }
    return response.blob()
  }

  // 첫 로그인 비밀번호 바꾸기. 강제는 화면(ax1-03) 몫이며 층은 바꾸기 호출만 둔다.
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!oldPassword || !newPassword) throw invalidInput("바꿀 비밀번호를 입력해 주세요.")
    try {
      await this.matrix.setPassword(
        {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: this.session.userId },
          password: oldPassword,
        },
        newPassword,
      )
    } catch (error) {
      if (isAxMessengerError(error)) throw error
      // 지시로 그대로 둔다: 기존 실패 갈래(auth)를 유지한다.
      const axError = toAxError(error, "비밀번호를 바꾸지 못했습니다. 기존 비밀번호를 확인해 주세요.")
      if (axError.kind === "forbidden") {
        throw new AxMessengerError({
          kind: "auth",
          userMessage: axError.userMessage,
          detail: axError.detail,
          status: axError.status,
          errcode: axError.errcode,
        })
      }
      throw axError
    }
  }

  private roomSummary(room: Room): AxRoomSummary {
    const events = room.getLiveTimeline().getEvents()
    const latest = [...events].reverse().find((event) => event.getType() === EventType.RoomMessage)
    return {
      roomId: room.roomId,
      name: room.name || "이름 없는 대화방",
      memberCount: room.getJoinedMembers().length,
      lastMessage: latest ? messageFromEvent(latest, room.roomId)?.body : undefined,
      lastMessageAt: latest?.getTs(),
    }
  }

  private async acceptInvites(): Promise<void> {
    const invites = this.matrix.getRooms().filter((room) => room.getMyMembership() === "invite")
    for (const room of invites) {
      try { await this.matrix.joinRoom(room.roomId) } catch { /* Retry on the next sync. */ }
    }
  }
}

export type { MatrixClient }
