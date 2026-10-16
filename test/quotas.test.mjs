import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "../index.mjs"

const { quotasToUsage } = _internal

test("full quotas response maps to four windows", () => {
  const { windows } = quotasToUsage({
    subscription: { limit: 600, requests: 12, renewsAt: "2026-04-30T20:18:54.144Z" },
    search: { hourly: { limit: 250, requests: 5, renewsAt: "2026-03-30T16:18:54.145Z" } },
    weeklyTokenLimit: { nextRegenAt: "2026-03-30T16:20:39.000Z", percentRemaining: 80 },
    rollingFiveHourLimit: { nextTickAt: "2026-03-30T15:30:29.000Z", tickPercent: 0.05, remaining: 450, max: 600, limited: false },
  })

  assert.equal(windows.length, 4)

  const five = windows[0]
  assert.equal(five.name, "5 hours")
  assert.equal(five.used, 25) // (600-450)/600
  assert.equal(five.resetsAt, "2026-03-30T15:30:29.000Z")
  assert.equal(five.span, 5 * 3600)
  assert.equal(five.display, "150 / 600 requests")
  assert.equal(five.aside, undefined)

  const weekly = windows[1]
  assert.equal(weekly.name, "weekly")
  assert.equal(weekly.used, 20) // 100 - 80
  assert.equal(weekly.resetsAt, "2026-03-30T16:20:39.000Z")
  assert.equal(weekly.span, 7 * 24 * 3600)

  const search = windows[2]
  assert.equal(search.name, "search / hour")
  assert.equal(search.used, 2) // 5/250
  assert.equal(search.aside, true)

  const sub = windows[3]
  assert.equal(sub.name, "billing period")
  assert.equal(sub.used, 2) // 12/600
  assert.equal(sub.aside, true)
})

test("docs example: subscription only", () => {
  const { windows } = quotasToUsage({
    subscription: { limit: 135, requests: 0, renewsAt: "2025-09-21T14:36:14.288Z" },
  })
  assert.equal(windows.length, 1)
  assert.equal(windows[0].name, "billing period")
  assert.equal(windows[0].used, 0)
})

test("body nested under data is unwrapped", () => {
  const { windows } = quotasToUsage({
    data: { rollingFiveHourLimit: { remaining: 0, max: 500, nextTickAt: "x" } },
  })
  assert.equal(windows.length, 1)
  assert.equal(windows[0].used, 100)
})

test("fractional remaining refills round to one decimal in display", () => {
  const { windows } = quotasToUsage({
    rollingFiveHourLimit: { remaining: 447.80000000000001, max: 500, nextTickAt: "x" },
  })
  assert.equal(windows[0].display, "52.2 / 500 requests")
})

test("empty and malformed responses yield no windows", () => {
  assert.deepEqual(quotasToUsage({}), { windows: [] })
  assert.deepEqual(quotasToUsage(null), { windows: [] })
  assert.deepEqual(quotasToUsage({ rollingFiveHourLimit: { max: 0 } }), { windows: [] })
})

test("weekly percentRemaining clamps into 0-100 used", () => {
  const { windows } = quotasToUsage({ weeklyTokenLimit: { percentRemaining: 110 } })
  assert.equal(windows[0].used, 0)
  const { windows: w2 } = quotasToUsage({ weeklyTokenLimit: { percentRemaining: -5 } })
  assert.equal(w2[0].used, 100)
})

test("live-shaped response: credits display and freeToolCalls lane", () => {
  const { windows } = quotasToUsage({
    subscription: { limit: 500, requests: 0, renewsAt: "2026-10-14T13:27:11.450Z" },
    search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-10-14T09:27:11.452Z" } },
    freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-10-15T08:27:11.456Z" },
    weeklyTokenLimit: { nextRegenAt: "2026-10-14T09:26:30.000Z", percentRemaining: 95.3678005, maxCredits: "$24.00", remainingCredits: "$22.88", nextRegenCredits: "$0.48" },
    rollingFiveHourLimit: { nextTickAt: "2026-10-14T08:35:01.000Z", tickPercent: 0.05, remaining: 498.2, max: 500, limited: false },
  })
  // freeToolCalls.limit is 0 -> no window for it
  assert.equal(windows.length, 4)
  const weekly = windows.find((w) => w.name === "weekly")
  assert.equal(weekly.display, "$22.88 / $24.00 credits")
  assert.equal(weekly.used, 5) // 100 - 95.37
})
