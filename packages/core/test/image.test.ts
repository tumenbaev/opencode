import { describe, expect } from "bun:test"
import photon from "@silvia-odwyer/photon-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Image.node))

function png(width: number, height: number) {
  const source = new photon.PhotonImage(new Uint8Array(width * height * 4).fill(255), width, height)
  try {
    return {
      uri: "file:///large.png",
      content: Buffer.from(source.get_bytes()).toString("base64"),
      encoding: "base64" as const,
      mime: "image/png",
    }
  } finally {
    source.free()
  }
}

describe("Image", () => {
  for (const [width, height] of [[2401, 2], [2, 2401]] as const) {
    it.live(`preserves a ${width}x${height} image under the default byte limit`, () =>
      Effect.gen(function* () {
        const image = yield* Image.Service
        const content = png(width, height)
        expect(content.content.length).toBeLessThan(5 * 1024 * 1024)
        expect(yield* image.normalize("large.png", content)).toEqual(content)
        yield* image.transform((editor) => editor.configure({ autoResize: false }))
        expect(yield* image.normalize("large.png", content)).toEqual(content)
      }),
    )
  }

  it.live("still rejects or resizes images exceeding the byte limit without dimension limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const content = png(2401, 2)
      const maxBase64Bytes = 128
      expect(content.content.length).toBeGreaterThan(maxBase64Bytes)
      yield* image.transform((editor) => editor.configure({ autoResize: false, maxBase64Bytes }))
      const error = yield* image.normalize("large.png", content).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Image.SizeError)
      expect(error.message).toContain("unlimitedxunlimited/128 bytes")

      yield* image.transform((editor) => editor.configure({ autoResize: true }))
      const result = yield* image.normalize("large.png", content)
      expect(result.content.length).toBeLessThanOrEqual(maxBase64Bytes)
    }),
  )
})
