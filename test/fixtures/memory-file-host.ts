import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { maskTextSpans } from '../../src/memory/contracts/text-spans.ts'
import { withRequestSource } from '../../src/shared/request-routing/header.ts'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { scratch } from './scratch.js'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../../src/memory/node/memory-document-store.ts'
import { memoryFileRevision } from '../../src/memory/node/memory-file-store.ts'
import { openMemoryNotes } from '../../src/memory/node/memory-note-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../../src/memory/node/source-identity.ts'
import { createVivaMemoryClient } from '../../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../../src/backend/memory-ipc.ts'
import { checkedIpc } from '../../src/shared/ipc-contract.ts'
import type { RawIpc } from '../../src/shared/ipc-contract.ts'
import type { HostMemoryCaller, HostMemoryMethod, HostMemoryApi, MemoryProject } from '../../src/memory/contracts/host.ts'
import { memoryFileMutationResult } from '../../src/memory/contracts/file-management.ts'
import type { MemoryHostEffect } from '../../src/memory/contracts/service.ts'

async function fixture(t: TestContext, text = 'The report is due Friday. Tea is served on Monday.') {
  const { dir, defer } = scratch(t, 'memory-file-host-')
  const options = { root: dir, hostNamespace: 'viva-test', dailyNotes: true,
    compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text, at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const source = store.readSource(sourceId)!, workspace = memorySourceWorkspace(source)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const current = store.readSource(id)
    return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
  } })
  const created = documents.commit({ operationId: randomUUID(), workspace, path: 'digest/wiki/report.md', expectedRevision: null,
    action: 'CREATE', markdown: 'Friday report', sources: [{ id: sourceId, token: memorySourceToken(source), spans: [{ start: 0, end: 25 }] }], reads: [] })
  // The trusted bridge authenticates the caller; the fixture exercises its typed client contract.
  const call: HostMemoryCaller = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) =>
    owner.handleHost(method, input) as Promise<HostMemoryApi[M]['output']>
  const client = createVivaMemoryClient(call)
  const identity = { kind: 'digest' as const, workspace, id: created.documentId }
  return { get owner() { return owner }, client, store, documents, created, identity, session, sourceId,
    async reopen(beforeRecovery?: () => void) { await owner.close(); owner = openMemoryOwner(options); beforeRecovery?.(); await owner.recover() } }
}

async function aborted(signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('send barrier did not request cancellation')), 2000)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}


export {
  randomUUID, maskTextSpans, withRequestSource, join, existsSync, readFileSync, writeFileSync, scratch, openMemoryOwner, openMemoryStore, openMemoryDocuments, memoryFileRevision, openMemoryNotes, memorySourceToken, memorySourceWorkspace, createVivaMemoryClient, registerRuntimeMemoryIpc, checkedIpc, memoryFileMutationResult, fixture, aborted,
}

export type { TestContext, RawIpc, HostMemoryCaller, HostMemoryMethod, HostMemoryApi, MemoryProject, MemoryHostEffect }
