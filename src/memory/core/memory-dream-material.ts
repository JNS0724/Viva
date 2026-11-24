import { formatMemoryDocument, parseMemoryDocument } from './memory-document.ts'

/** Inspect prose without mistaking backend-issued content-addressed references for credentials.
 * The caller supplies exact paths/metadata values from authorized snapshots and canonical source identities,
 * never model-proposed values. This view is only for validation; actual model content and line offsets stay unchanged. */
export function inspectMemoryDocumentText(markdown: string, trustedPaths: readonly string[],
  trustedMetadata: readonly { key: string, value: string }[] = []): string {
  const document = parseMemoryDocument(markdown)
  const metadata = { ...document.metadata }
  for (const field of trustedMetadata) if (metadata[field.key] === field.value) metadata[field.key] = '[memory-reference]'
  let inspected = formatMemoryDocument({ ...document, metadata })
  for (const path of [...new Set(trustedPaths)].sort((left, right) => right.length - left.length)) {
    if (path) inspected = inspected.replaceAll(path, '[memory-reference]')
  }
  return inspected
}

/** Replace only exact backend-verified wikilink target paths (`[[path]]` / `[[path#anchor]]`), keeping anchors and prose intact. */
export function stripTrustedMemoryLinks(text: string, trustedPaths: readonly string[]): string {
  const allowed = new Set(trustedPaths.filter(Boolean))
  if (!allowed.size) return text
  return text.replace(/\[\[([^\[\]\r\n#]+)(#[^\[\]\r\n]*)?\]\]/gu, (match, targetPath: string, anchor: string | undefined) =>
    allowed.has(targetPath) ? `[memory-reference]${anchor ?? ''}` : match)
}
