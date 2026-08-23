import { describe, expect, test } from "bun:test"
import { displayCharAt, displaySlice, mentionTriggerIndex, slashTriggerIndex } from "../../src/prompt/display"

describe("prompt display", () => {
  test("uses display-width offsets for mentions", () => {
    expect(mentionTriggerIndex("@")).toBe(0)
    expect(mentionTriggerIndex("test @")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("こんにちは @")).toBe(11)
    expect(mentionTriggerIndex("한국어 @")).toBe(7)
    expect(mentionTriggerIndex("🙂 @")).toBe(3)
    expect(mentionTriggerIndex("中文 @src file", Bun.stringWidth("中文 @src"))).toBe(5)
    expect(displayCharAt("中文 @src", Bun.stringWidth("中文 @"))).toBe("s")
    expect(displaySlice("中文 @src", 5, Bun.stringWidth("中文 @src"))).toBe("@src")
    expect(displaySlice("中文 @src", 6, Bun.stringWidth("中文 @src"))).toBe("src")
    expect(mentionTriggerIndex("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe(3)
    expect(displayCharAt("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @"))).toBe("s")
    expect(displaySlice("👨‍👩‍👧‍👦 @src", 3, Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe("@src")
    expect(mentionTriggerIndex("@file1\n@file2", 13)).toBe(7)
    expect(displayCharAt("@file1\n@file2", 6)).toBe("\n")
    expect(displaySlice("@file1\n@file2", 8, 13)).toBe("file2")
    expect(mentionTriggerIndex("@file1\nfoo @file2", 17)).toBe(11)
    expect(mentionTriggerIndex("中文 @one\n@two", 14)).toBe(10)
    expect(displaySlice("中文 @one\n@two", 11, 14)).toBe("two")
    expect(mentionTriggerIndex("中文@")).toBeUndefined()
    expect(mentionTriggerIndex("こんにちは@")).toBeUndefined()
    expect(mentionTriggerIndex("한국어@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("foo@bar.com")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @src file")).toBeUndefined()
  })

  test("finds leading and whitespace-delimited slash triggers", () => {
    expect(slashTriggerIndex("/")).toBe(0)
    expect(slashTriggerIndex("/review")).toBe(0)
    expect(slashTriggerIndex("run /review")).toBe(4)
    expect(slashTriggerIndex("run\t/review")).toBe(3)
    expect(slashTriggerIndex("run\n/review")).toBe(4)
  })

  test("finds slash triggers before the cursor and ignores the suffix", () => {
    expect(slashTriggerIndex("run /review later", Bun.stringWidth("run /rev"))).toBe(4)
    expect(slashTriggerIndex("/review later", Bun.stringWidth("/rev"))).toBe(0)
  })

  test("uses display-width offsets for slash triggers", () => {
    expect(slashTriggerIndex("中文 /review")).toBe(5)
    expect(slashTriggerIndex("こんにちは /review")).toBe(11)
    expect(slashTriggerIndex("한국어 /review")).toBe(7)
    expect(slashTriggerIndex("🙂 /review")).toBe(3)
    expect(slashTriggerIndex("👨‍👩‍👧‍👦 /review")).toBe(3)
    expect(slashTriggerIndex("中文 /review later", Bun.stringWidth("中文 /rev"))).toBe(5)
  })

  test("rejects invalid slash triggers", () => {
    expect(slashTriggerIndex("review")).toBeUndefined()
    expect(slashTriggerIndex("run/review")).toBeUndefined()
    expect(slashTriggerIndex("中文/review")).toBeUndefined()
    expect(slashTriggerIndex("run /review later")).toBeUndefined()
    expect(slashTriggerIndex("/review later")).toBeUndefined()
  })

  test("keeps the first slash for nested command names", () => {
    expect(slashTriggerIndex("/project/review")).toBe(0)
    expect(slashTriggerIndex("run /project/review")).toBe(4)
    expect(slashTriggerIndex("run /project/review later", Bun.stringWidth("run /project/rev"))).toBe(4)
  })
})
