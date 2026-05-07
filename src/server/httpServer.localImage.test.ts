import { describe, expect, it } from 'vitest'
import { decodeCodexLocalImagePathQuery } from './httpServer'

describe('decodeCodexLocalImagePathQuery', () => {
  it('decodes tunnel-friendly base64url local image paths', () => {
    const path = 'C:/Users/youdo/.codex/generated_images/thread-id/ig_123.png'
    const encodedPath = Buffer.from(path, 'utf8').toString('base64url')

    expect(decodeCodexLocalImagePathQuery({ p: encodedPath })).toBe(path)
  })

  it('keeps legacy path query support', () => {
    const path = 'C:/Users/youdo/.codex/generated_images/thread-id/ig_123.png'

    expect(decodeCodexLocalImagePathQuery({ path })).toBe(path)
  })
})
