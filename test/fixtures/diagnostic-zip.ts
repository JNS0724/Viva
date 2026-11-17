import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'

/** Independent store-only ZIP decoder, including CRC and local/central offset checks. */
export function unzipStored(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0)
  const entries = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const result = new Map<string, Buffer>()
  for (let index = 0; index < entries; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50)
    assert.equal(archive.readUInt16LE(offset + 10), 0)
    const checksum = archive.readUInt32LE(offset + 16), size = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28), extraLength = archive.readUInt16LE(offset + 30), commentLength = archive.readUInt16LE(offset + 32)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString()
    const local = archive.readUInt32LE(offset + 42)
    assert.equal(archive.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
    const data = archive.subarray(start, start + size)
    assert.equal(data.length, size)
    assert.equal(crc32(data), checksum)
    result.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return result
}
