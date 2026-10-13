import { measureEditText, type WidthMethod } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Returns the index of the last grapheme boundary in `value` whose editor offset is at most `offset`. */
export function promptOffsetIndex(value: string, offset: number, widthMethod: WidthMethod) {
  // Offsets never decrease as a prefix grows by whole graphemes, so binary search needs O(log n) measurements.
  const boundaries = [...Array.from(graphemes.segment(value), (part) => part.index), value.length]
  let low = 0
  let high = boundaries.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measureEditText(value.slice(0, boundaries[middle]), { widthMethod }) > offset) {
      high = middle - 1
      continue
    }
    low = middle
  }
  return boundaries[low]
}

export function mentionTriggerIndex(text: string, widthMethod: WidthMethod) {
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return measureEditText(text.slice(0, index), { widthMethod })
  }
}

export function slashTriggerIndex(text: string, widthMethod: WidthMethod) {
  for (let index = text.lastIndexOf("/"); index >= 0; index = text.lastIndexOf("/", index - 1)) {
    const before = index === 0 ? undefined : text[index - 1]
    const query = text.slice(index)
    if (before !== undefined && !/\s/.test(before)) continue
    if (/\s/.test(query) || query.slice(1).includes("/")) return
    return measureEditText(text.slice(0, index), { widthMethod })
  }
}

export function inlineSlashToken(
  value: string,
  widthMethod: WidthMethod,
  offset = measureEditText(value, { widthMethod }),
) {
  const cursor = promptOffsetIndex(value, offset, widthMethod)
  const text = value.slice(0, cursor)
  const match = /(?:^|\s)(\/\S*)$/.exec(text)
  if (!match) return
  const index = text.length - match[1].length
  if (index === 0) return
  const suffix = value.slice(cursor).match(/^\S*/)?.[0] ?? ""
  return {
    start: measureEditText(text.slice(0, index), { widthMethod }),
    end: measureEditText(value.slice(0, cursor + suffix.length), { widthMethod }),
  }
}
