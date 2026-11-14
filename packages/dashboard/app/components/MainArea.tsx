"use client"

import { usePathname } from "next/navigation"
import React from "react"
import { mainClassForPath } from "./nav-tabs"

export function MainArea({ children }: { children: React.ReactNode }) {
  return <main className={mainClassForPath(usePathname())}>{children}</main>
}
