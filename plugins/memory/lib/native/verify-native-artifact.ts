import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

/** The pinned backend writes standard checksummed Zstd frames. Node may accept
 * incomplete input and only decompresses one frame per call. Verify boundaries
 * separately before asking Node to verify checksums. */
function* decodeFrames(log: Buffer): Generator<Buffer> {
  let offset = 0
  function advance(bytes: number) {
    const previous = offset
    offset += bytes
    if (offset > log.length) throw new Error('Native session has a torn Zstd frame')
    return previous
  }
  while (offset < log.length) {
    const start = advance(4)
    if (log.readUInt32LE(start) !== 0xfd2fb528) throw new Error('Invalid Zstd session frame')
    const header = log[advance(1)]!
    const singleSegment = Boolean(header & 0x20)
    if ((header & 0x18) || !(header & 4)) throw new Error('Unsupported Zstd session frame')
    const size = header >>> 6, dictionary = header & 3
    advance((singleSegment ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (size ? 1 << size : Number(singleSegment)))
    let last = false
    while (!last) {
      const block = log.readUIntLE(advance(3), 3), encoding = (block >>> 1) & 3
      if (encoding === 3) throw new Error('Invalid Zstd session block')
      advance(encoding === 1 ? 1 : block >>> 3)
      last = Boolean(block & 1)
    }
    advance(4)
    yield zstdDecompressSync(log.subarray(start, offset))
  }
}

/** The official reader verifies record contents. This check also rejects bytes
 * after its committed prefix, which it may intentionally ignore when loading. */
export async function verifyCompleteArtifact(file: string, hash: string, compressed: boolean, events: number) {
  const log = await readFile(file)
  if (createHash('sha256').update(log).digest('hex') !== hash) throw new Error('Native session artifact changed during validation')
  let lines = 0, lastByte: number | undefined
  for (const data of compressed ? decodeFrames(log) : [log]) {
    for (const byte of data) if (byte === 0x0a) lines++
    lastByte = data.at(-1) ?? lastByte
  }
  if (lastByte !== 0x0a || lines !== events + 1) throw new Error('Native session has bytes outside its verified event log')
}
