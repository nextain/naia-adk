import assert from "node:assert/strict"
import test from "node:test"
import { MatrixEvent } from "matrix-js-sdk"
import { messageFromEvent } from "./index.js"

test("maps a Matrix text event into the portable chat shape", () => {
  const event = new MatrixEvent({
    event_id: "$event",
    sender: "@member:tenant.example.invalid",
    origin_server_ts: 42,
    type: "m.room.message",
    room_id: "!room:tenant.example.invalid",
    content: { msgtype: "m.text", body: "hello https://example.com" },
  })
  assert.deepEqual(messageFromEvent(event, "!room:tenant.example.invalid"), {
    eventId: "$event",
    roomId: "!room:tenant.example.invalid",
    sender: "@member:tenant.example.invalid",
    body: "hello https://example.com",
    timestamp: 42,
    messageType: "m.text",
    mediaUrl: undefined,
    mimeType: undefined,
    size: undefined,
  })
})

test("ignores non-message Matrix events", () => {
  const event = new MatrixEvent({ type: "m.room.member", content: { membership: "join" } })
  assert.equal(messageFromEvent(event, "!room:tenant.example.invalid"), null)
})
