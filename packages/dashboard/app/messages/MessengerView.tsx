"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ChevronLeft, Hash, User, X } from "lucide-react"
import { PanelResizer } from "../docs/PanelResizer"
import { Composer } from "./Composer"
import { DocPreview } from "./DocPreview"
import { MessageItem } from "./MessageItem"
import {
  alertText,
  applyStreamEvent,
  channelLabel,
  decideApproval,
  loadAlerts,
  loadChannels,
  loadRoles,
  setMentionRoles,
  loadMessages,
  loadMessagesThrough,
  markRead,
  messagesHref,
  messengerUrl,
  MSG,
  optimisticReaction,
  postMessage,
  reconnectDelay,
  streamPath,
  splitThreads,
  threadRootOf,
  toggleReaction,
  uploadAttachment,
  upsertMessage,
  type Channel,
  type Message,
  type MessengerAlert,
  type MessengerState,
  type StreamEventType,
} from "./messenger"

const STREAM_EVENTS: StreamEventType[] = ["message", "attachment", "reaction", "read", "approval", "alert"]
const PAGE_SIZE = 50
const SIDE_WIDTH_KEY = "messages.sideWidth"

export type SidePanel = { kind: "thread"; rootId: string } | { kind: "doc"; key: string } | null

export interface MessengerViewProps {
  initialChannelId?: string | null
  initialMessageId?: string | null
  // 시험용: 주면 처음 불러오기를 건너뛴다.
  initialState?: MessengerState
  initialPanel?: SidePanel
  fetchFn?: typeof fetch
  disableStream?: boolean
  now?: Date
}

type StreamStatus = "live" | "reconnecting"

// SSE 를 붙이고, 끊기면 브라우저가 Last-Event-ID 로 다시 붙는다. 완전히 닫히면 직접 다시 연다.
function useMessengerStream(
  enabled: boolean,
  onEvent: (type: StreamEventType, data: unknown) => void,
  onReconnected: () => void,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("reconnecting")
  const handlers = useRef({ onEvent, onReconnected })
  handlers.current = { onEvent, onReconnected }
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return
    let es: EventSource | null = null
    let attempt = 0
    let lost = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let lastEventId: string | null = null
    const connect = () => {
      if (stopped) return
      es = new EventSource(messengerUrl(streamPath(lastEventId)))
      es.onopen = () => {
        setStatus("live")
        attempt = 0
        // 커서 없는 첫 연결은 과거를 다시 받지 않으므로, 첫 읽기와 연결 사이에 온 글을 한 번 채운다.
        if (lost || lastEventId === null) handlers.current.onReconnected()
        lost = false
      }
      for (const type of STREAM_EVENTS) {
        es.addEventListener(type, (ev) => {
          if ((ev as MessageEvent).lastEventId) lastEventId = (ev as MessageEvent).lastEventId
          try {
            handlers.current.onEvent(type, JSON.parse((ev as MessageEvent).data))
          } catch {
            // 모양이 틀린 이벤트는 버린다.
          }
        })
      }
      es.onerror = () => {
        setStatus("reconnecting")
        lost = true
        if (es && es.readyState === EventSource.CLOSED) {
          es.close()
          timer = setTimeout(connect, reconnectDelay(attempt++))
        }
      }
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }, [enabled])
  return enabled ? status : "live"
}

function useIsWide(): boolean {
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const update = () => setWide(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return wide
}

function writeUrl(href: string) {
  if (typeof window === "undefined") return
  if (window.location.pathname !== href) window.history.replaceState(null, "", href)
}

export function AlertBanner({
  alerts,
  channels,
  onOpen,
  onDismiss,
}: {
  alerts: MessengerAlert[]
  channels: Channel[]
  onOpen: (a: MessengerAlert) => void
  onDismiss: (a: MessengerAlert) => void
}) {
  if (alerts.length === 0) return null
  const shown = alerts.slice(0, 3)
  return (
    <div role="alert" data-testid="messenger-alert" className="border-b border-rose-900 bg-rose-800 text-white">
      {shown.map((a) => (
        <div key={`${a.message_id}-${a.target_id ?? ""}`} className="flex items-center gap-2 px-3 sm:px-4 py-1.5 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-semibold shrink-0 max-sm:hidden">{MSG.alertTitle}</span>
          <span className="min-w-0 flex-1 truncate">{alertText(a, channels)}</span>
          {a.channel_id && (
            <button
              type="button"
              data-testid="messenger-alert-open"
              onClick={() => onOpen(a)}
              className="shrink-0 px-2 py-0.5 rounded-md border border-white/60 bg-white/15 hover:bg-white/30 text-xs font-medium"
            >
              {MSG.alertOpen}
            </button>
          )}
          <button type="button" aria-label="이 알림 숨기기" onClick={() => onDismiss(a)} className="shrink-0 p-0.5 rounded hover:bg-white/20">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {alerts.length > shown.length && <div className="px-4 pb-1.5 text-xs text-rose-100">외 {alerts.length - shown.length}건</div>}
    </div>
  )
}

export function ChannelList({
  channels,
  activeId,
  onSelect,
}: {
  channels: Channel[]
  activeId: string | null
  onSelect: (c: Channel) => void
}) {
  const groups: Array<{ title: string; items: Channel[] }> = [
    { title: MSG.channels, items: channels.filter((c) => c.kind !== "dm") },
    { title: MSG.dms, items: channels.filter((c) => c.kind === "dm") },
  ]
  return (
    <nav aria-label="채널 목록" data-testid="channel-list" className="py-2">
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.title} className="mb-3">
            <div className="px-3 pb-1 text-xs font-semibold text-neutral-500">{g.title}</div>
            <ul>
              {g.items.map((c) => {
                const active = c.id === activeId
                const Icon = c.kind === "dm" ? User : Hash
                return (
                  <li key={c.id}>
                    <a
                      href={messagesHref(c.id)}
                      data-testid="channel-item"
                      data-channel-id={c.id}
                      aria-current={active ? "page" : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) return
                        e.preventDefault()
                        onSelect(c)
                      }}
                      className={`mx-1.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                        active
                          ? "dashboard-selected bg-neutral-800 text-white"
                          : c.unread > 0
                            ? "text-neutral-100 font-semibold hover:bg-neutral-900"
                            : "text-neutral-400 hover:bg-neutral-900 hover:text-white"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0 text-neutral-500" />
                      <span className="min-w-0 flex-1 truncate">{c.kind === "dm" ? channelLabel(c) : c.name}</span>
                      {c.unread > 0 && !active && (
                        <span data-testid="channel-unread" className="min-w-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] leading-5 text-center font-semibold">
                          {c.unread > 99 ? "99+" : c.unread}
                        </span>
                      )}
                    </a>
                  </li>
                )
              })}
            </ul>
          </div>
        ),
      )}
    </nav>
  )
}

export function MessengerView({
  initialChannelId = null,
  initialMessageId = null,
  initialState,
  initialPanel = null,
  fetchFn,
  disableStream = false,
  now,
}: MessengerViewProps) {
  const f = fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const [state, setState] = useState<MessengerState>(initialState ?? { channels: [], messages: {}, alerts: [] })
  const [activeId, setActiveId] = useState<string | null>(initialChannelId ?? null)
  const [focusId, setFocusId] = useState<string | null>(initialMessageId)
  const [panel, setPanel] = useState<SidePanel>(initialPanel)
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">(initialState ? "idle" : "loading")
  const [channelsError, setChannelsError] = useState(false)
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({})
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [sideWidth, setSideWidth] = useState(440)
  const wide = useIsWide()
  const listRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const focusRef = useRef(focusId)
  focusRef.current = focusId

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(SIDE_WIDTH_KEY))
    if (saved >= 320 && saved <= 900) setSideWidth(saved)
  }, [])

  const refreshChannels = useCallback(async () => {
    try {
      const channels = await loadChannels(f)
      setChannelsError(false)
      setState((s) => ({ ...s, channels }))
      return channels
    } catch {
      setChannelsError(true)
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFn])

  const refreshMessages = useCallback(
    async (channelId: string) => {
      setLoadState((s) => (stateRef.current.messages[channelId] ? s : "loading"))
      try {
        const page = await loadMessagesThrough(channelId, focusRef.current, { limit: PAGE_SIZE }, f)
        setState((s) => {
          let merged = s.messages[channelId] ?? []
          for (const m of page.messages) merged = upsertMessage(merged, m)
          return { ...s, messages: { ...s.messages, [channelId]: merged } }
        })
        // 직접 링크로 이전 페이지까지 받았으면 그 끝이 '더 보기'의 기준이다.
        setHasMore((h) => ({ ...h, [channelId]: page.pages > 1 ? page.hasMore : h[channelId] ?? page.hasMore }))
        setLoadState("idle")
      } catch {
        setLoadState("error")
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchFn],
  )

  // @ 자동 완성 역할 목록은 서버 설정을 따른다(못 받으면 기본 목록).
  const [, setRolesVersion] = useState(0)
  useEffect(() => {
    if (disableStream) return
    let alive = true
    loadRoles(f)
      .then((roles) => {
        if (!alive) return
        setMentionRoles(roles)
        setRolesVersion((v) => v + 1)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFn, disableStream])

  // 처음 불러오기
  useEffect(() => {
    if (initialState) return
    let alive = true
    ;(async () => {
      const channels = await refreshChannels()
      if (!alive || !channels) return
      if (!activeRef.current && window.matchMedia("(min-width: 640px)").matches && channels[0]) {
        setActiveId(channels[0].id)
      }
      loadAlerts(f)
        .then((alerts) => alive && setState((s) => ({ ...s, alerts })))
        .catch(() => undefined)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 채널을 바꾸면 다시 읽는다. 같은 채널에서 고른 글(무응답 알림의 '글 보기' 등)이 아직 없으면 그 글까지 불러온다.
  const shownChannelRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeId || initialState?.messages[activeId]) return
    const switched = shownChannelRef.current !== activeId
    shownChannelRef.current = activeId
    const list = stateRef.current.messages[activeId]
    if (!switched && (!focusId || !list || list.some((m) => m.id === focusId))) return
    void refreshMessages(activeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, focusId])

  const messages = useMemo(() => (activeId ? state.messages[activeId] ?? [] : []), [activeId, state.messages])
  const { roots, replies } = useMemo(() => splitThreads(messages), [messages])
  const activeChannel = state.channels.find((c) => c.id === activeId) ?? null
  const lastId = messages[messages.length - 1]?.id

  // 읽음 표시: 보고 있는 채널의 마지막 글
  useEffect(() => {
    if (!activeId || !lastId || initialState) return
    setState((s) => ({ ...s, channels: s.channels.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c)) }))
    void markRead(activeId, lastId, f).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, lastId])

  // 새 글이 오면 바닥에 붙어 있을 때만 따라 내려간다. 주소로 고른 글이 있으면 그 글로.
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (focusId) {
      const target = document.getElementById(`msg-${focusId}`)
      if (target) {
        target.scrollIntoView({ block: "center" })
        return
      }
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [roots.length, activeId, focusId])

  // 주소로 고른 글이 답글이면 스레드를 연다.
  useEffect(() => {
    if (!focusId) return
    const m = messages.find((x) => x.id === focusId)
    const root = m ? threadRootOf(m) : null
    if (root && messages.some((x) => x.id === root)) setPanel({ kind: "thread", rootId: root })
  }, [focusId, messages])

  const status = useMessengerStream(
    !disableStream,
    (type, data) => {
      // 같은 순간에 이벤트가 여럿 오면(승인 → 코드 글) 앞 이벤트 반영을 덮지 않도록 함수형으로 갱신한다.
      const ctx = { activeChannelId: activeRef.current }
      setState((s) => applyStreamEvent(s, type, data, ctx).state)
      // 다시 읽을지 판단만 마지막 화면 상태로 한다(모르는 글의 반응·승인).
      const result = applyStreamEvent(stateRef.current, type, data, ctx)
      if (result.refetchChannel) void refreshMessages(result.refetchChannel)
      if (result.refetchChannels) void refreshChannels()
    },
    () => {
      // 다시 붙으면 놓친 글을 채운다.
      void refreshChannels()
      if (activeRef.current) void refreshMessages(activeRef.current)
      loadAlerts(f)
        .then((alerts) => setState((s) => ({ ...s, alerts })))
        .catch(() => undefined)
    },
  )

  const selectChannel = (c: Channel | string, messageId: string | null = null) => {
    const id = typeof c === "string" ? c : c.id
    setActiveId(id)
    setFocusId(messageId)
    setPanel((p) => (p?.kind === "thread" ? null : p))
    stickRef.current = true
    writeUrl(messagesHref(id, messageId))
  }

  const send = async (body: string, attachmentIds: string[], replyTo: string | null) => {
    if (!activeId) return
    const msg = await postMessage(activeId, body, replyTo, attachmentIds, f)
    stickRef.current = true
    setState((s) => ({ ...s, messages: { ...s.messages, [msg.channel_id || activeId]: upsertMessage(s.messages[msg.channel_id || activeId] ?? [], { ...msg, channel_id: msg.channel_id || activeId }) } }))
  }

  const react = async (m: Message, emoji: string) => {
    const mine = Boolean(m.reactions.find((r) => r.emoji === emoji)?.mine)
    const before = m.reactions
    const patch = (reactions: Message["reactions"]) =>
      setState((s) => ({
        ...s,
        messages: { ...s.messages, [m.channel_id]: (s.messages[m.channel_id] ?? []).map((x) => (x.id === m.id ? { ...x, reactions } : x)) },
      }))
    patch(optimisticReaction(before, emoji).map((r) => ({ ...r })))
    try {
      await toggleReaction(m.id, emoji, mine, f)
    } catch {
      patch(before)
    }
  }

  const decide = async (m: Message, decision: "approve" | "reject") => {
    await decideApproval(m.id, decision, f)
    setState((s) => ({
      ...s,
      messages: {
        ...s.messages,
        [m.channel_id]: (s.messages[m.channel_id] ?? []).map((x) =>
          x.id === m.id && x.approval ? { ...x, approval: { ...x.approval, status: decision === "approve" ? "approved" : "rejected" } } : x,
        ),
      },
    }))
  }

  const loadOlder = async () => {
    if (!activeId || !messages[0]) return
    stickRef.current = false
    try {
      const older = await loadMessages(activeId, { before: messages[0].id, limit: PAGE_SIZE }, f)
      setHasMore((h) => ({ ...h, [activeId]: older.length >= PAGE_SIZE }))
      setState((s) => {
        let merged = s.messages[activeId] ?? []
        for (const m of older) merged = upsertMessage(merged, m)
        return { ...s, messages: { ...s.messages, [activeId]: merged } }
      })
    } catch {
      setLoadState("error")
    }
  }

  const openDoc = (key: string) => setPanel({ kind: "doc", key })
  const openThread = (m: Message) => setPanel({ kind: "thread", rootId: threadRootOf(m) ?? m.id })
  const upload = (file: File) => uploadAttachment(file, f)
  const actions = { onReact: react, onReply: openThread, onOpenThread: openThread, onOpenDoc: openDoc, onDecide: decide }
  const visibleAlerts = state.alerts.filter((a) => !hidden.has(`${a.message_id}-${a.target_id ?? ""}`))

  const threadRoot = panel?.kind === "thread" ? messages.find((m) => m.id === panel.rootId) ?? null : null
  const threadReplies = threadRoot ? replies.get(threadRoot.id) ?? [] : []

  const sideContent =
    panel?.kind === "doc" ? (
      <DocPreview key={panel.key} docKey={panel.key} onClose={() => setPanel(null)} fetchFn={fetchFn} />
    ) : threadRoot ? (
      <section data-testid="thread-panel" aria-label={MSG.thread} className="flex h-full min-h-0 flex-col bg-neutral-950">
        <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-neutral-100">{MSG.thread}</div>
            {activeChannel && <div className="text-xs text-neutral-500">{channelLabel(activeChannel)}</div>}
          </div>
          <button type="button" aria-label={MSG.closePanel} onClick={() => setPanel(null)} className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-900">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          <MessageItem message={threadRoot} now={now} compact {...actions} onReply={undefined} />
          <div className="mx-4 my-1 flex items-center gap-2 text-xs text-neutral-500">
            <span>{MSG.replies(threadReplies.length)}</span>
            <span className="h-px flex-1 bg-neutral-800" />
          </div>
          {threadReplies.map((m) => (
            <MessageItem key={m.id} message={m} now={now} compact highlighted={m.id === focusId} {...actions} onReply={undefined} />
          ))}
        </div>
        <Composer
          testId="thread-composer"
          placeholder="스레드에 답글 쓰기"
          onSend={(body, ids) => send(body, ids, threadRoot.id)}
          onUpload={upload}
        />
      </section>
    ) : null

  const showListOnly = !activeId // 좁은 화면: 채널을 고르기 전에는 목록만
  return (
    <div data-testid="messenger" className="flex h-[calc(100dvh-var(--dashboard-nav-height))] min-h-0 flex-col">
      <AlertBanner
        alerts={visibleAlerts}
        channels={state.channels}
        onOpen={(a) => a.channel_id && selectChannel(a.channel_id, a.message_id)}
        onDismiss={(a) => setHidden((h) => new Set(h).add(`${a.message_id}-${a.target_id ?? ""}`))}
      />
      <div className="flex min-h-0 flex-1">
        <aside
          data-testid="messenger-sidebar"
          className={`${showListOnly ? "flex w-full" : "hidden"} sm:flex sm:w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 min-h-0`}
        >
          <div className="px-3 pt-3 pb-1 text-base font-bold text-white">{MSG.title}</div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {channelsError && <p className="px-3 py-2 text-xs text-red-300">{MSG.channelsFailed}</p>}
            <ChannelList channels={state.channels} activeId={activeId} onSelect={(c) => selectChannel(c)} />
          </div>
        </aside>

        <section data-testid="messenger-main" className={`${showListOnly ? "hidden sm:flex" : "flex"} min-w-0 flex-1 flex-col min-h-0`}>
          <header className="flex items-center gap-2 border-b border-neutral-800 px-3 sm:px-4 h-11 shrink-0">
            <button
              type="button"
              data-testid="messenger-back"
              aria-label={MSG.backToList}
              onClick={() => {
                setActiveId(null)
                writeUrl("/messages")
              }}
              className="sm:hidden -ml-1 p-1 rounded-md text-neutral-400 hover:text-white"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h1 data-testid="messenger-channel-title" className="min-w-0 truncate text-sm font-semibold text-neutral-100">
              {activeChannel ? channelLabel(activeChannel) : ""}
            </h1>
            <span
              data-testid="messenger-stream-status"
              title={status === "live" ? MSG.live : MSG.reconnecting}
              className={`ml-auto inline-flex items-center gap-1.5 text-xs ${status === "live" ? "text-neutral-500" : "text-amber-300"}`}
            >
              <span className={`w-2 h-2 rounded-full ${status === "live" ? "bg-emerald-500" : "bg-amber-400 animate-pulse"}`} />
              <span className={status === "live" ? "max-sm:hidden" : ""}>{status === "live" ? MSG.live : MSG.reconnecting}</span>
            </span>
          </header>

          <div
            ref={listRef}
            data-testid="message-list"
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="min-h-0 flex-1 overflow-y-auto py-2"
          >
            {activeId && hasMore[activeId] && (
              <div className="flex justify-center py-1">
                <button type="button" onClick={loadOlder} className="px-3 py-1 rounded-md text-xs text-neutral-400 hover:text-white hover:bg-neutral-900">
                  이전 글 더 보기
                </button>
              </div>
            )}
            {loadState === "loading" && messages.length === 0 && <p className="px-4 py-6 text-sm text-neutral-400">{MSG.loading}</p>}
            {loadState === "error" && <p className="px-4 py-2 text-sm text-red-300">{MSG.loadFailed}</p>}
            {loadState !== "loading" && activeId && messages.length === 0 && loadState !== "error" && (
              <p className="px-4 py-6 text-sm text-neutral-500">{MSG.empty}</p>
            )}
            {roots.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                now={now}
                replyCount={replies.get(m.id)?.length ?? 0}
                highlighted={m.id === focusId}
                {...actions}
              />
            ))}
          </div>

          {activeChannel && (
            <Composer
              key={activeChannel.id}
              placeholder={MSG.placeholder(channelLabel(activeChannel).replace("# ", "#"))}
              onSend={(body, ids) => send(body, ids, null)}
              onUpload={upload}
            />
          )}
        </section>

        {sideContent &&
          (wide ? (
            <>
              <PanelResizer
                value={sideWidth}
                min={320}
                max={900}
                defaultValue={440}
                mode="right-px"
                ariaLabel="오른쪽 창 너비"
                onChange={(v) => {
                  setSideWidth(v)
                  window.localStorage.setItem(SIDE_WIDTH_KEY, String(v))
                }}
              />
              <aside data-testid="messenger-side" style={{ width: sideWidth }} className="shrink-0 min-h-0 border-l border-neutral-800">
                {sideContent}
              </aside>
            </>
          ) : (
            <aside data-testid="messenger-side" className="fixed inset-x-0 bottom-0 top-[var(--dashboard-nav-height)] z-30 min-h-0 bg-neutral-950">
              {sideContent}
            </aside>
          ))}
      </div>
    </div>
  )
}
