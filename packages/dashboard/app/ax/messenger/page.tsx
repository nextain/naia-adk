"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { loadSelectedMessages } from "./selection.mjs"

type Room = { roomId: string; name: string }
type Message = { eventId: string; sender: string; body: string }
const api = "/api/ax-messenger"

class MessengerRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request(path: string, body?: unknown) {
  const response = await fetch(api + path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new MessengerRequestError(response.status, result?.error || "요청을 처리하지 못했습니다.")
  return result
}

export default function AxMessengerPage() {
  const [user, setUser] = useState("")
  const [password, setPassword] = useState("")
  const [connected, setConnected] = useState(false)
  const [rooms, setRooms] = useState<Room[]>([])
  const [selected, setSelected] = useState("")
  const selectedRef = useRef({ room: "" })
  const [messages, setMessages] = useState<Message[]>([])
  const [body, setBody] = useState("")
  const [error, setError] = useState("")
  const resetSession = useCallback(() => {
    setConnected(false)
    setRooms([])
    setMessages([])
    selectedRef.current = { room: "" }
    setSelected("")
  }, [])
  const handleSessionError = useCallback((err: unknown, fallback: string) => {
    if (err instanceof MessengerRequestError && err.status === 401) resetSession()
    setError(err instanceof Error ? err.message : fallback)
  }, [resetSession])
  const refresh = useCallback(async () => {
    const selection = selectedRef.current
    if (selection.room !== selected) return
    try {
      const result = await request("/rooms")
      if (selectedRef.current !== selection) return
      setRooms(result.rooms)
      if (selected) {
        const messages = await loadSelectedMessages(selected, async (roomId: string) => (await request(`/messages?roomId=${encodeURIComponent(roomId)}`)).messages, () => selectedRef.current, selection)
        if (messages !== null) setMessages(messages)
      }
    } catch (err) {
      if (err instanceof MessengerRequestError && err.status === 401) {
        resetSession()
        setError(err.message)
        return
      }
      if (selectedRef.current === selection) setError(err instanceof Error ? err.message : "연결에 실패했습니다.")
    }
  }, [selected, resetSession])
  useEffect(() => {
    if (!connected) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [connected, refresh])
  async function login(event: React.FormEvent) {
    event.preventDefault(); setError("")
    try { await request("/login", { user, password }); setPassword(""); setConnected(true) }
    catch (err) { setPassword(""); setError(err instanceof Error ? err.message : "연결에 실패했습니다.") }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); setError("")
    try { await request("/send", { roomId: selected, body }); setBody(""); await refresh() }
    catch (err) { handleSessionError(err, "전송에 실패했습니다.") }
  }
  async function logout() {
    try { await request("/logout", {}); resetSession() }
    catch (err) { handleSessionError(err, "연결을 종료하지 못했습니다.") }
  }
  return <main className="p-6 space-y-4">
    <h1 className="text-xl font-semibold">Matrix 대화</h1>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!connected ? <form onSubmit={login} className="flex flex-col gap-3 max-w-sm">
      <label>Matrix 계정<input className="block w-full text-black" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" required /></label>
      <label>비밀번호<input className="block w-full text-black" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      <button className="border p-2" type="submit">연결</button>
    </form> : <div className="space-y-4">
      <button className="border p-2" type="button" onClick={logout}>연결 종료</button>
      <div className="flex gap-6 flex-wrap">
        <nav aria-label="대화방" className="min-w-48">{rooms.map(room => <button className="block p-2" type="button" aria-pressed={selected === room.roomId} key={room.roomId} onClick={() => { selectedRef.current = { room: room.roomId }; setSelected(room.roomId); setMessages([]); setError("") }}>{room.name}</button>)}</nav>
        <section className="flex-1 min-w-64" aria-label="대화 내용">
          {selected ? <><ul>{messages.map(message => <li key={message.eventId} className="py-2"><strong>{message.sender}</strong><p className="whitespace-pre-wrap">{message.body}</p></li>)}</ul>
            <form onSubmit={send} className="flex gap-2"><input className="text-black flex-1" aria-label="메시지" value={body} onChange={e => setBody(e.target.value)} required /><button className="border p-2" type="submit">보내기</button></form></> : <p>대화방을 선택해 주세요.</p>}
        </section>
      </div>
    </div>}
  </main>
}
