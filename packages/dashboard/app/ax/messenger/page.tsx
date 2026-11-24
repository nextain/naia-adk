"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { loadSelectedMessages } from "./selection.mjs"
import { axErrorMessage, MessengerRequestError } from "./ax-errors.ts"
import { tFor } from "../../i18n/index.ts"
import { getActiveLocale } from "../../i18n/provider.tsx"
import type { TranslationKey } from "../../i18n/types.ts"

type Room = { roomId: string; name: string }
type Message = { eventId: string; sender: string; body: string }
const api = "/api/ax-messenger"

async function request(path: string, fallback: string, body?: unknown) {
  const response = await fetch(api + path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new MessengerRequestError(response.status, result?.error || fallback, result?.code)
  return result
}

export default function AxMessengerPage() {
  const locale = getActiveLocale()
  const t = tFor(locale)
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
  const handleSessionError = useCallback((err: unknown, fallbackKey: TranslationKey) => {
    if (err instanceof MessengerRequestError && err.status === 401) resetSession()
    setError(axErrorMessage(err, t, fallbackKey))
  }, [resetSession, t])
  const refresh = useCallback(async () => {
    const selection = selectedRef.current
    if (selection.room !== selected) return
    try {
      const result = await request("/rooms", t("ax.err.requestFailed"))
      if (selectedRef.current !== selection) return
      setRooms(result.rooms)
      if (selected) {
        const messages = await loadSelectedMessages(selected, async (roomId: string) => (await request(`/messages?roomId=${encodeURIComponent(roomId)}`, t("ax.err.requestFailed"))).messages, () => selectedRef.current, selection)
        if (messages !== null) setMessages(messages)
      }
    } catch (err) {
      if (err instanceof MessengerRequestError && err.status === 401) {
        resetSession()
        setError(axErrorMessage(err, t, "ax.err.loginRequired"))
        return
      }
      if (selectedRef.current === selection) setError(axErrorMessage(err, t, "ax.err.connectFailed"))
    }
  }, [selected, resetSession, t])
  useEffect(() => {
    if (!connected) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [connected, refresh])
  async function login(event: React.FormEvent) {
    event.preventDefault(); setError("")
    try { await request("/login", t("ax.err.connectFailed"), { user, password }); setPassword(""); setConnected(true) }
    catch (err) { setPassword(""); setError(axErrorMessage(err, t, "ax.err.connectFailed")) }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); setError("")
    try { await request("/send", t("ax.err.sendFailed"), { roomId: selected, body }); setBody(""); await refresh() }
    catch (err) { handleSessionError(err, "ax.err.sendFailed") }
  }
  async function logout() {
    try { await request("/logout", t("ax.err.logoutFailed"), {}); resetSession() }
    catch (err) { handleSessionError(err, "ax.err.logoutFailed") }
  }
  return <main className="p-6 space-y-4">
    <h1 className="text-xl font-semibold">{t("ax.title")}</h1>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!connected ? <form onSubmit={login} className="flex flex-col gap-3 max-w-sm">
      <label>{t("ax.account")}<input className="block w-full text-black" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" required /></label>
      <label>{t("ax.password")}<input className="block w-full text-black" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      <button className="border p-2" type="submit">{t("ax.connect")}</button>
    </form> : <div className="space-y-4">
      <button className="border p-2" type="button" onClick={logout}>{t("ax.disconnect")}</button>
      <div className="flex gap-6 flex-wrap">
        <nav aria-label={t("ax.roomsLabel")} className="min-w-48">{rooms.map(room => <button className="block p-2" type="button" aria-pressed={selected === room.roomId} key={room.roomId} onClick={() => { selectedRef.current = { room: room.roomId }; setSelected(room.roomId); setMessages([]); setError("") }}>{room.name}</button>)}</nav>
        <section className="flex-1 min-w-64" aria-label={t("ax.messagesLabel")}>
          {selected ? <><ul>{messages.map(message => <li key={message.eventId} className="py-2"><strong>{message.sender}</strong><p className="whitespace-pre-wrap">{message.body}</p></li>)}</ul>
            <form onSubmit={send} className="flex gap-2"><input className="text-black flex-1" aria-label={t("ax.messageAria")} value={body} onChange={e => setBody(e.target.value)} required /><button className="border p-2" type="submit">{t("ax.send")}</button></form></> : <p>{t("ax.selectRoom")}</p>}
        </section>
      </div>
    </div>}
  </main>
}
