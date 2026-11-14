"use client"

// 문서 보기 머리의 [짧은 주소] 단추 (ADK 기본 기능).
// 서버(server.mjs)의 POST /d 로 짧은 키를 등록하고 "<지금 주소의 앞부분>/d/<키>" 를 복사한다.
// 휴대폰은 http 테일넷 주소에서 navigator.clipboard 가 없으므로(보안 문맥 아님) 숨긴 글 칸 복사로 바꾸고,
// 그것도 안 되면 주소를 글 칸에 띄워 길게 눌러 복사하게 한다.

import React, { useState } from "react"
import { Link2 } from "lucide-react"

export function shortPathFallback(source: string, docPath: string): string {
  return `/d/${[source, ...docPath.split("/")].map(encodeURIComponent).join("/")}`
}

async function requestShortPath(source: string, docPath: string): Promise<string> {
  try {
    const res = await fetch("/d", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, path: docPath }),
    })
    if (res.ok) {
      const body = (await res.json()) as { path?: string }
      if (typeof body.path === "string" && body.path.startsWith("/d/")) return body.path
    }
  } catch {}
  // 등록에 실패해도 표 없이 열리는 경로 형식으로 준다.
  return shortPathFallback(source, docPath)
}

function copyWithTextarea(text: string): boolean {
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    let ok = false
    try {
      ok = document.execCommand("copy") === true
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  return copyWithTextarea(text)
}

export function ShortLinkButton({ source, path: docPath }: { source: string; path: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle")
  const [url, setUrl] = useState("")

  const onClick = async () => {
    const shortPath = await requestShortPath(source, docPath)
    const full = `${window.location.origin}${shortPath}`
    setUrl(full)
    if (await copyText(full)) {
      setStatus("copied")
      window.setTimeout(() => setStatus("idle"), 1500)
    } else {
      setStatus("manual")
    }
  }

  return (
    <span data-print="hide" className="print:hidden inline-flex items-center gap-1.5 min-w-0">
      <button
        type="button"
        onClick={onClick}
        title="짧은 주소 복사"
        aria-label="짧은 주소 복사"
        data-testid="short-link-button"
        className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-neutral-800 text-xs text-neutral-400 hover:text-neutral-200 transition-colors shrink-0"
      >
        <Link2 className="w-4 h-4" />
        <span>{status === "copied" ? "복사됨" : "짧은 주소"}</span>
      </button>
      {status === "manual" && (
        <input
          readOnly
          value={url}
          aria-label="짧은 주소"
          onFocus={(e) => e.currentTarget.select()}
          className="w-44 px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-700 text-xs text-neutral-200"
        />
      )}
    </span>
  )
}
