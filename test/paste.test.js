import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlToText, pastedParts } from '../src/renderer/paste.js'
import { checkImages, imageUrl, isImageId, mimeOfId, sniffImageType } from '../src/shared/images.js'

const clipboard = ({ files = [], plain = '', html = '' } = {}) => ({
  files,
  getData: (type) => ({ 'text/plain': plain, 'text/html': html })[type] ?? '',
})
const PNG = { type: 'image/png', name: 'image.png' }

test('words copied only as formatted text (WeChat, a web page) are read out of the HTML', () => {
  const parts = pastedParts(clipboard({ files: [PNG], html: '<p>网页里的<b>文字</b></p><img src="x.png"><p>第二段</p>' }))
  assert.deepEqual(parts, { images: [PNG], text: '网页里的文字\n第二段' })
})

test('a picture with plain words: both are taken, the words put in by hand since the paste is stopped', () => {
  assert.deepEqual(pastedParts(clipboard({ files: [PNG], plain: '图片加文字', html: '<p>x</p>' })), { images: [PNG], text: '图片加文字' })
})

test('plain words alone are left to the field', () => {
  assert.deepEqual(pastedParts(clipboard({ plain: '只有文字' })), { images: [], text: null })
})

test('only HTML without a picture: the words still come through', () => {
  assert.deepEqual(pastedParts(clipboard({ html: '<div>一行<br>两行</div>' })), { images: [], text: '一行\n两行' })
})

test('a picture alone, and kinds that are not pictures the model reads', () => {
  assert.deepEqual(pastedParts(clipboard({ files: [PNG] })), { images: [PNG], text: '' })
  assert.deepEqual(pastedParts(clipboard({ files: [{ type: 'image/tiff' }, { type: 'application/pdf' }] })), { images: [], text: null })
})

test('htmlToText drops scripts and styles and decodes entities', () => {
  assert.equal(htmlToText('<style>p{}</style><p>a &amp; b &lt;c&gt; &#x4e2d;&#25991;&nbsp;!</p><script>x()</script>'), 'a & b <c> 中文 !')
  assert.equal(htmlToText('<p>一</p>\n\n\n\n<p>二</p>'), '一\n\n二')
  assert.equal(htmlToText(null), '')
})

test('pictures are told by their first bytes, not by what the clipboard calls them', () => {
  const bytes = (...head) => Uint8Array.from([...head, ...new Array(12).fill(0)])
  assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png')
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
  assert.equal(sniffImageType(bytes(...Buffer.from('GIF89a'))), 'image/gif')
  assert.equal(sniffImageType(Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')])), 'image/webp')
  assert.equal(sniffImageType(bytes(...Buffer.from('<svg'))), null)
  assert.equal(sniffImageType(Uint8Array.from([0x89, 0x50])), null)
})

test('a picture is named by its SHA-256 and kind; anything else is refused', () => {
  const id = `${'a'.repeat(64)}.png`
  assert.equal(isImageId(id), true)
  assert.equal(isImageId(`../${id}`), false)
  assert.equal(isImageId(`${'a'.repeat(64)}.svg`), false)
  assert.equal(mimeOfId(`${'b'.repeat(64)}.jpg`), 'image/jpeg')
  assert.equal(imageUrl(id), `viva-image://img/${id}`)
  assert.deepEqual(checkImages([{ id, extra: 1 }]), [{ id }])
  assert.deepEqual(checkImages(undefined), [])
  assert.equal(checkImages([{ id: 'x.png' }]), null)
  assert.equal(checkImages(new Array(11).fill({ id })), null)
})
