export type AxSession = {
  homeserverUrl: string
  userId: string
  accessToken: string
  deviceId?: string
}

export type AxRoomSummary = {
  roomId: string
  name: string
  memberCount: number
  lastMessage?: string
  lastMessageAt?: number
}

export type AxChatMessage = {
  eventId: string
  roomId: string
  sender: string
  body: string
  timestamp: number
  messageType: string
  mediaUrl?: string
  mimeType?: string
  size?: number
  mentionUserIds?: string[]
  replyToEventId?: string
}

export type AxTextOptions = {
  mentionUserIds?: string[]
  replyToEventId?: string
}

export type AxParticipant = {
  userId: string
  displayName: string
  membership: string
}

export type AxFile = {
  name: string
  mimeType: string
  size: number
  data: XMLHttpRequestBodyInit
}
