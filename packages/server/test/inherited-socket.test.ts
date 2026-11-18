import { describe, it, expect } from "vitest"
import { inheritedSocketFd } from "../src/server.js"

describe("inherited listen socket", () => {
  it("uses fd 3 when LISTEN_PID is this process and LISTEN_FDS is 1", () => {
    expect(inheritedSocketFd({ LISTEN_FDS: "1", LISTEN_PID: "42" }, 42)).toBe(3)
  })

  it("binds the configured port when there is none or it belongs to another process", () => {
    expect(inheritedSocketFd({}, 42)).toBeNull()
    expect(inheritedSocketFd({ LISTEN_FDS: "1" }, 42)).toBeNull()
    expect(inheritedSocketFd({ LISTEN_FDS: "1", LISTEN_PID: "41" }, 42)).toBeNull()
  })

  it("refuses to pick when this process was given anything but one socket", () => {
    expect(() => inheritedSocketFd({ LISTEN_FDS: "2", LISTEN_PID: "42" }, 42)).toThrow(/LISTEN_FDS=2/)
    expect(() => inheritedSocketFd({ LISTEN_FDS: "0", LISTEN_PID: "42" }, 42)).toThrow(/LISTEN_FDS=0/)
  })
})
