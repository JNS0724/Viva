import assert from 'node:assert/strict'

/** Public Web state used only by the packed-plugin acceptance driver. */
export interface MemoryWebComposerSnapshot {
  sessionKey: string | null
  blank: boolean
  editable: boolean
  text: string
}

/** The editor DOM is retained across bindings, so visibility cannot identify a new session. */
export async function beginMemoryWebSession({ read, create, wait }: {
  read(): Promise<MemoryWebComposerSnapshot>
  create(): Promise<void>
  wait(check: () => Promise<boolean>): Promise<void>
}): Promise<void> {
  const previous = await read()
  assert.ok(previous.sessionKey, 'the previous session has an observable row identity')
  await create()
  await wait(async () => {
    const next = await read()
    return Boolean(next.sessionKey?.startsWith('session:') && next.sessionKey !== previous.sessionKey && next.blank && next.editable && next.text === '')
  })
}

/** Fail before clicking Send if a binding transition lost any part of the synthetic input. */
export async function submitMemoryWebMessage(expected: string, { read, submit }: {
  read(): Promise<string>
  submit(): Promise<void>
}): Promise<void> {
  assert.equal(await read(), expected, 'the Web composer must retain the exact synthetic input before submission')
  await submit()
}
