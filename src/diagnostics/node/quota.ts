import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, lstat } from 'node:fs/promises'
import path from 'node:path'
import { DIAGNOSTIC_LIMITS } from '../contracts.ts'
import type { DiagnosticComponent } from '../contracts.ts'

export interface DiagnosticSlot { id: string; file: string; pid: number; instance: string; bytes: number; closed: boolean; createdAt: number }
export interface ExportPin { id: string; pid: number; files: string[]; temporary?: string }
interface Inventory { version: 1; slots: DiagnosticSlot[]; pins: ExportPin[] }
export const DIAGNOSTIC_FILE = /^(shell|renderer|backend|dsh|memory|worker)-[a-f0-9-]{36}\.jsonl$/
const INVENTORY_BYTES = 64 * 1024
const CONTROL_BYTES = 2 * INVENTORY_BYTES + 8192
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const absent = (error: unknown) => isObject(error) && error.code === 'ENOENT'
const missingPid = (pid: number) => { try { process.kill(pid, 0); return false } catch (error) { return isObject(error) && error.code === 'ESRCH' } }
const unavailable = (message: string, code: 'quota_full' | 'busy') => Object.assign(new Error(message), { code })

/** Reservations include open files and pins. Uncertain handles remain charged. */
export class DiagnosticQuota {
  readonly directory: string
  readonly instance = randomUUID()
  private serial: Promise<unknown> = Promise.resolve()
  private readonly maxBytes: number
  private readonly fileBytes: number
  constructor(directory: string, limits: { maxBytes?: number; fileBytes?: number } = {}) {
    this.directory = path.resolve(directory)
    this.maxBytes = limits.maxBytes ?? DIAGNOSTIC_LIMITS.directoryBytes
    this.fileBytes = limits.fileBytes ?? DIAGNOSTIC_LIMITS.fileBytes
  }
  private async load(): Promise<Inventory> {
    const file = path.join(this.directory, 'inventory.json')
    let text: string
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > INVENTORY_BYTES) throw new Error('Invalid diagnostic inventory file')
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (!absent(error)) throw error
      if ((await readdir(this.directory)).some(name => DIAGNOSTIC_FILE.test(name))) throw new Error('Diagnostic inventory missing')
      return { version: 1, slots: [], pins: [] }
    }
    const data: unknown = JSON.parse(text)
    if (!isObject(data) || data.version !== 1 || !Array.isArray(data.slots) || data.slots.length > 128 || !Array.isArray(data.pins) || data.pins.length > 1) throw new Error('Invalid diagnostic inventory')
    for (const slot of data.slots) {
      if (!isObject(slot) || typeof slot.id !== 'string' || !/^[a-f0-9-]{36}$/.test(slot.id)
        || typeof slot.file !== 'string' || !DIAGNOSTIC_FILE.test(slot.file) || typeof slot.instance !== 'string'
        || !Number.isSafeInteger(slot.pid) || Number(slot.pid) <= 0 || typeof slot.closed !== 'boolean'
        || typeof slot.bytes !== 'number' || !Number.isSafeInteger(slot.bytes) || slot.bytes < 0 || slot.bytes > this.maxBytes
        || typeof slot.createdAt !== 'number' || !Number.isFinite(slot.createdAt)) throw new Error('Invalid diagnostic slot')
    }
    for (const pin of data.pins) if (!isObject(pin) || typeof pin.id !== 'string' || !/^[a-f0-9-]{36}$/.test(pin.id) || !Number.isSafeInteger(pin.pid)
      || Number(pin.pid) <= 0 || !Array.isArray(pin.files) || pin.files.some(file => typeof file !== 'string' || !DIAGNOSTIC_FILE.test(file))
      || pin.temporary !== undefined && (typeof pin.temporary !== 'string' || pin.temporary.length > 4096 || !path.isAbsolute(pin.temporary) || !pin.temporary.endsWith(`.${pin.id}.partial`))) throw new Error('Invalid diagnostic pin')
    return data as unknown as Inventory
  }
  private async transaction<T>(work: (data: Inventory) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('Diagnostic directory is a symlink')
    const lockPath = path.join(this.directory, 'inventory.lock')
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 20 && !handle; attempt++) {
      try { handle = await open(lockPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, instance: this.instance })) }
      catch (error) {
        if (handle) { await handle.close().catch(() => {}); handle = undefined; await unlink(lockPath).catch(() => {}) }
        if (!isObject(error) || error.code !== 'EEXIST') throw error
        try {
          if ((await stat(lockPath)).size <= 1024) {
            const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
            if (isObject(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && missingPid(Number(owner.pid))) await unlink(lockPath)
          }
        } catch { /* A live or uncertain lock is never forcefully stolen. */ }
        await delay(25)
      }
    }
    if (!handle) throw unavailable('Diagnostic quota is busy', 'busy')
    try {
      const data = await this.load()
      for (const pin of [...data.pins]) if (missingPid(pin.pid)) {
        if (pin.temporary) await unlink(pin.temporary).catch(error => { if (!absent(error)) throw error })
        data.pins = data.pins.filter(item => item.id !== pin.id)
      }
      for (const slot of data.slots) if (!slot.closed && missingPid(slot.pid)) {
        slot.closed = true
        try { slot.bytes = (await stat(path.join(this.directory, slot.file))).size } catch (error) { if (absent(error)) slot.bytes = 0; else throw error }
      }
      const result = await work(data)
      const encoded = JSON.stringify(data)
      if (Buffer.byteLength(encoded) > INVENTORY_BYTES) throw new Error('Diagnostic inventory is full')
      const temporary = path.join(this.directory, 'inventory.tmp')
      const target = await open(temporary, 'w', 0o600)
      try { await target.writeFile(encoded) } finally { await target.close() }
      await rename(temporary, path.join(this.directory, 'inventory.json'))
      return result
    } finally {
      await handle.close()
      await unlink(lockPath).catch(() => {})
    }
  }
  private run<T>(work: (data: Inventory) => Promise<T>): Promise<T> {
    const task = this.serial.catch(() => {}).then(() => this.transaction(work))
    this.serial = task
    return task
  }
  reserve(component: DiagnosticComponent): Promise<DiagnosticSlot> {
    return this.run(async data => {
      const active = new Set(data.slots.filter(slot => !slot.closed).map(slot => slot.instance))
      if (!active.has(this.instance) && active.size >= DIAGNOSTIC_LIMITS.writers) throw unavailable('Diagnostic writer limit', 'quota_full')
      const pinned = new Set(data.pins.flatMap(pin => pin.files))
      let used = CONTROL_BYTES + data.slots.reduce((sum, slot) => sum + slot.bytes, 0)
      for (const slot of [...data.slots].sort((a, b) => a.createdAt - b.createdAt)) {
        if (!slot.closed || pinned.has(slot.file) || data.slots.length < 128 && used + this.fileBytes <= this.maxBytes && Date.now() - slot.createdAt < DIAGNOSTIC_LIMITS.retentionMs) continue
        await unlink(path.join(this.directory, slot.file)).catch(error => { if (!absent(error)) throw error })
        used -= slot.bytes
        data.slots = data.slots.filter(item => item.id !== slot.id)
      }
      if (used + this.fileBytes > this.maxBytes) throw unavailable('Diagnostic quota full', 'quota_full')
      if (data.slots.length >= 128) throw unavailable('Diagnostic inventory is full', 'quota_full')
      const id = randomUUID()
      const slot: DiagnosticSlot = { id, file: `${component}-${id}.jsonl`, instance: this.instance, pid: process.pid,
        bytes: this.fileBytes, closed: false, createdAt: Date.now() }
      data.slots.push(slot)
      return { ...slot }
    })
  }
  close(slot: DiagnosticSlot): Promise<void> {
    return this.run(async data => {
      const current = data.slots.find(item => item.id === slot.id && item.instance === this.instance)
      if (!current) return
      const size = await stat(path.join(this.directory, slot.file)).then(value => value.size, error => { if (absent(error)) return 0; throw error })
      current.bytes = size
      current.closed = true
    })
  }
  pin(pid: number, options: { id?: string; temporary?: string } = {}): Promise<{ pin: ExportPin; files: Array<{ file: string; cutoff: number }> }> {
    return this.run(async data => {
      if (data.pins.length) throw unavailable('Diagnostic export is active', 'busy')
      const files: Array<{ file: string; cutoff: number }> = []
      let bytes = 0
      for (const slot of [...data.slots].sort((a, b) => b.createdAt - a.createdAt)) {
        let cutoff: number
        try { const info = await lstat(path.join(this.directory, slot.file)); if (!info.isFile()) continue; cutoff = Math.min(info.size, slot.bytes) }
        catch (error) { if (absent(error)) continue; throw error }
        cutoff = Math.min(cutoff, DIAGNOSTIC_LIMITS.exportSourceBytes - bytes)
        if (cutoff <= 0) continue
        files.push({ file: slot.file, cutoff }); bytes += cutoff
        if (bytes >= DIAGNOSTIC_LIMITS.exportSourceBytes) break
      }
      const id = options.id ?? randomUUID()
      if (!/^[a-f0-9-]{36}$/.test(id) || options.temporary !== undefined && (!path.isAbsolute(options.temporary) || !options.temporary.endsWith(`.${id}.partial`))) throw new Error('Invalid diagnostic export identity')
      const pin: ExportPin = { id, pid, files: files.map(item => item.file), ...(options.temporary ? { temporary: options.temporary } : {}) }
      data.pins.push(pin)
      return { pin, files }
    })
  }
  release(pin: ExportPin): Promise<void> { return this.run(async data => { data.pins = data.pins.filter(item => item.id !== pin.id) }) }
  clearClosed(): Promise<boolean> {
    return this.run(async data => {
      const pinned = new Set(data.pins.flatMap(pin => pin.files))
      for (const slot of [...data.slots]) if (slot.closed && !pinned.has(slot.file)) {
        await unlink(path.join(this.directory, slot.file)).catch(error => { if (!absent(error)) throw error })
        data.slots = data.slots.filter(item => item.id !== slot.id)
      }
      return data.slots.length === 0 && data.pins.length === 0
    })
  }
}
