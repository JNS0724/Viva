import { promisify } from 'node:util'
import zlib from 'node:zlib'

/**
 * dsh appends to its session log one zstd frame per write. Node before 24.22 decompresses only the first
 * frame of such a file (and the app's runtime, pinned for dsh, is older), so the frames are split here
 * (RFC 8878 layout) and decompressed one by one.
 */
const FRAME_MAGIC = 0xFD2FB528
const SKIPPABLE_MASK = 0xFFFFFFF0
const SKIPPABLE_MAGIC = 0x184D2A50
const BLOCK_RLE = 1
const BLOCK_RESERVED = 3
const DICT_ID_BYTES = [0, 1, 2, 4]
const CONTENT_SIZE_BYTES = [0, 2, 4, 8]
const BLOCK_HEADER_BYTES = 3
const CHECKSUM_BYTES = 4

const zstdDecompress = promisify(zlib.zstdDecompress)

function need(buffer: Buffer, end: number): void {
  if (end > buffer.length) throw new Error('zstd: the data ends inside a frame')
}

/** Where the frame starting at `start` ends. */
function frameEnd(buffer: Buffer, start: number): number {
  const descriptor = buffer[start + 4]
  const singleSegment = (descriptor >> 5) & 1
  const contentSizeFlag = descriptor >> 6
  const hasChecksum = (descriptor >> 2) & 1
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : CONTENT_SIZE_BYTES[contentSizeFlag]
  let at = start + 5 + (singleSegment ? 0 : 1) + DICT_ID_BYTES[descriptor & 3] + contentSizeBytes
  for (;;) {
    need(buffer, at + BLOCK_HEADER_BYTES)
    const header = buffer.readUIntLE(at, BLOCK_HEADER_BYTES)
    const type = (header >> 1) & 3
    if (type === BLOCK_RESERVED) throw new Error('zstd: reserved block type')
    at += BLOCK_HEADER_BYTES + (type === BLOCK_RLE ? 1 : header >> 3)
    if (header & 1) break
  }
  at += hasChecksum ? CHECKSUM_BYTES : 0
  need(buffer, at)
  return at
}

/** The zstd frames in `buffer`, in order; skippable frames are left out. */
export function splitZstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let at = 0
  while (at < buffer.length) {
    need(buffer, at + 4)
    const magic = buffer.readUInt32LE(at)
    if (((magic & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC) {
      need(buffer, at + 8)
      at += 8 + buffer.readUInt32LE(at + 4)
      continue
    }
    if (magic !== FRAME_MAGIC) throw new Error('zstd: not a frame')
    need(buffer, at + 5)
    const end = frameEnd(buffer, at)
    frames.push(buffer.subarray(at, end))
    at = end
  }
  return frames
}

/** Every frame decompressed and joined, whatever the runtime's zstd does with several frames. */
export async function decompressZstdFrames(buffer: Buffer): Promise<Buffer> {
  const parts: Buffer[] = []
  for (const frame of splitZstdFrames(buffer)) parts.push(await zstdDecompress(frame))
  return Buffer.concat(parts)
}
