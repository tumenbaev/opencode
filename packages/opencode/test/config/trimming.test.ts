import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(ConfigV1.Info)

describe("legacy trimming config", () => {
  test("leaves trimming and its defaults absent for the engine to resolve", () => {
    expect(decode({}).trimming).toBeUndefined()
    expect(decode({ trimming: {} }).trimming).toEqual({})
    expect(decode({ trimming: { model: "custom/model" } }).trimming).toEqual({ model: "custom/model" })
  })

  test("preserves explicit opt-in settings", () => {
    const trimming = {
      enabled: true,
      model: "openai/gpt-5.6-luna",
      variant: "high",
      threshold: 0.7,
    }
    expect(decode({ trimming }).trimming).toEqual(trimming)
    expect(decode({ trimming: { enabled: false } }).trimming).toEqual({ enabled: false })
  })

  test.each([Number.MIN_VALUE, 0.7, 1])("accepts threshold %s", (threshold) => {
    expect(decode({ trimming: { threshold } }).trimming?.threshold).toBe(threshold)
  })

  test.each([0, -0.1, 1.01, NaN, Infinity, -Infinity, "0.7", null])("rejects threshold %s", (threshold) => {
    expect(() => decode({ trimming: { threshold } })).toThrow()
  })

  test.each([{ enabled: "true" }, { model: 42 }, { variant: false }, true, null])(
    "rejects invalid trimming settings %j",
    (trimming) => {
      expect(() => decode({ trimming })).toThrow()
    },
  )
})
