"use client"

import React, { useEffect, useRef, useState } from "react"
import {
  beginDragUserSelect,
  clampSize,
  getNextSizeFromKey,
  restoreUserSelect,
} from "./panel-size"

export interface PanelResizerProps {
  value: number
  min: number
  max: number
  step?: number
  defaultValue: number
  ariaLabel: string
  mode?: "left-px" | "right-px" | "percent"
  onChange: (newValue: number) => void
  className?: string
  "data-testid"?: string
}

export function PanelResizer({
  value,
  min,
  max,
  step = 16,
  defaultValue,
  ariaLabel,
  mode = "left-px",
  onChange,
  className = "",
  "data-testid": testId,
}: PanelResizerProps) {
  const resizerRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startValRef = useRef(value)
  const previousUserSelectRef = useRef<string>("")
  const [isDragging, setIsDragging] = useState(false)

  // 1.5 끌기 종료 및 정리 (포인터 뗌, 캡처 상실, 언마운트 시 호출)
  const stopDragging = (pointerId?: number) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    setIsDragging(false)

    if (pointerId !== undefined && resizerRef.current) {
      try {
        resizerRef.current.releasePointerCapture(pointerId)
      } catch {}
    }
    if (typeof document !== "undefined") {
      restoreUserSelect(document.body.style, previousUserSelectRef.current)
    }
  }

  // 언마운트 시 끌기 상태 정리
  useEffect(() => {
    return () => {
      if (isDraggingRef.current) {
        stopDragging()
      }
    }
  }, [])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 마우스 왼쪽 단추만 (button === 0)
    if (e.button !== 0) return

    isDraggingRef.current = true
    startXRef.current = e.clientX
    startValRef.current = value
    setIsDragging(true)

    const el = resizerRef.current
    if (el) {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
    }

    // 드래그 중 텍스트 선택 방지 (원래 스타일 기억)
    if (typeof document !== "undefined") {
      previousUserSelectRef.current = beginDragUserSelect(document.body.style)
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return

    const deltaX = e.clientX - startXRef.current

    if (mode === "left-px") {
      const next = clampSize(startValRef.current + deltaX, min, max)
      onChange(Math.round(next))
    } else if (mode === "right-px") {
      const next = clampSize(startValRef.current - deltaX, min, max)
      onChange(Math.round(next))
    } else if (mode === "percent") {
      const parentWidth = resizerRef.current?.parentElement?.clientWidth || 1000
      const deltaPercent = (deltaX / parentWidth) * 100
      const next = clampSize(startValRef.current + deltaPercent, min, max)
      onChange(Math.round(next))
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    stopDragging(e.pointerId)
  }

  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    stopDragging(e.pointerId)
  }

  const handleDoubleClick = () => {
    onChange(defaultValue)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault()
      const next = getNextSizeFromKey(
        e.key,
        value,
        min,
        max,
        step,
        mode === "right-px",
      )
      onChange(Math.round(next))
    }
  }

  return (
    <div
      ref={resizerRef}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
      data-testid={testId}
      data-print="hide"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handleLostPointerCapture}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={`print:hidden group relative flex items-center justify-center shrink-0 cursor-col-resize select-none touch-none focus:outline-none focus:ring-1 focus:ring-blue-500 ${
        isDragging ? "bg-blue-600/30" : "hover:bg-neutral-700/50"
      } ${className}`}
      style={{ width: "8px" }}
    >
      <div
        className={`w-[1px] h-full transition-colors ${
          isDragging ? "bg-blue-500" : "bg-neutral-800 group-hover:bg-neutral-600"
        }`}
      />
    </div>
  )
}
