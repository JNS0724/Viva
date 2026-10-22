/**
 * CSV and TSV for the 文件 preview's table view (RFC 4180): fields split on the delimiter, quoted fields may
 * hold the delimiter, doubled quotes and line breaks. Values stay strings, exactly as written.
 */
export const MAX_ROWS = 2000

/**
 * @param {string} text
 * @param {',' | '\t'} delimiter
 * @returns {{ rows: string[][], more: number }} at most MAX_ROWS rows; `more` counts the rest
 */
export function parseTable(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let more = 0
  const endRow = () => {
    row.push(field)
    if (rows.length < MAX_ROWS) rows.push(row)
    else more += 1
    row = []
    field = ''
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      endRow()
    } else field += char
  }
  if (field !== '' || row.length > 0) endRow()
  return { rows, more }
}
