"use client"

import React from "react"
import { useParams } from "next/navigation"
import { MessengerView } from "../MessengerView"
import { parseMessagesPath } from "../messenger"

// /messages, /messages/<채널>, /messages/<채널>/<글> (깨움 파일의 주소 모양)
export default function MessagesPage() {
  const params = useParams<{ path?: string[] }>()
  const { channelId, messageId } = parseMessagesPath(params?.path)
  return <MessengerView initialChannelId={channelId} initialMessageId={messageId} />
}
