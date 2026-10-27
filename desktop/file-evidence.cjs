// Prefix-only format observations. No archive decompression or content execution.
const path = require('node:path')
const EVIDENCE_VERSION = 3
const MAX_PREFIX_BYTES = 32 * 1024
const SIGNATURES = [
  ['sqlite', 'SQLite 数据库', '53514c69746520666f726d6174203300', ['.db', '.sqlite', '.sqlite3']],
  ['pdf', 'PDF 文档', '255044462d', ['.pdf']],
  ['png', 'PNG 图片', '89504e470d0a1a0a', ['.png']],
  ['jpeg', 'JPEG 图片', 'ffd8ff', ['.jpg', '.jpeg', '.jpe']],
  ['gif', 'GIF 图片', '474946383761', ['.gif']],
  ['gif', 'GIF 图片', '474946383961', ['.gif']],
  ['tiff', 'TIFF 图片', '49492a00', ['.tif', '.tiff']],
  ['tiff', 'TIFF 图片', '4d4d002a', ['.tif', '.tiff']],
  ['7z', '7-Zip 归档', '377abcaf271c', ['.7z']],
  ['rar', 'RAR 归档', '526172211a07', ['.rar']],
  ['gzip', 'GZip 压缩数据', '1f8b08', ['.gz', '.tgz']],
  ['flac', 'FLAC 音频', '664c6143', ['.flac']],
  ['ogg', 'Ogg 媒体容器', '4f676753', ['.ogg', '.oga', '.ogv', '.opus']],
  ['elf', 'ELF 可执行或共享对象', '7f454c46', ['.elf', '.so', '.bin']],
  ['ole', 'OLE 复合文档容器', 'd0cf11e0a1b11ae1', ['.doc', '.xls', '.ppt', '.msg', '.msi']]
]

function zipEntryNames(buffer) {
  const names = []
  let offset = 0
  // Read only valid local headers wholly contained in the supplied prefix.
  while (offset + 30 <= buffer.length && names.length < 80) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break
    const flags = buffer.readUInt16LE(offset + 6)
    const compressed = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const start = offset + 30
    const dataStart = start + nameLength + extraLength
    if (!nameLength || nameLength > 1024 || dataStart > buffer.length || flags & 1) break
    names.push(buffer.subarray(start, start + nameLength).toString('utf8'))
    if (flags & 8 || compressed === 0xffffffff) break // descriptor / ZIP64 need a separate bounded parser
    const next = dataStart + compressed
    if (next <= offset || next > buffer.length) break
    offset = next
  }
  return names
}

function identifyPrefix(prefix, filePath = '', fileSize = prefix?.length || 0) {
  const buffer = Buffer.isBuffer(prefix) ? prefix.subarray(0, MAX_PREFIX_BYTES) : Buffer.alloc(0)
  let match = SIGNATURES.find(([, , hex]) => buffer.length >= hex.length / 2 && buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex')))
  let status = 'matched'
  let confidence = .96
  let details = []
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'MZ') {
    const offset = buffer.length >= 64 ? buffer.readUInt32LE(60) : -1
    const verified = offset >= 64 && offset + 24 <= buffer.length && buffer.toString('ascii', offset, offset + 4) === 'PE\u0000\u0000'
    match = verified ? ['pe', 'Windows PE 可执行文件', '', ['.exe', '.dll', '.sys', '.scr', '.ocx', '.cpl']] : ['mz', 'MZ 文件头（PE 格式尚未确认）', '', ['.exe', '.dll', '.sys']]
    status = verified ? 'matched' : offset >= buffer.length && fileSize > buffer.length ? 'prefix-limited' : 'incomplete'
    confidence = verified ? .98 : .55
    details = [verified ? 'MZ 与 PE 签名、头部偏移相互印证' : '仅发现 MZ，可能为 DOS 文件、损坏文件或超出读取上限的 PE 头']
  } else if (buffer.length >= 4 && ['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) {
    const names = zipEntryNames(buffer)
    const office = names.includes('[Content_Types].xml') && [
      ['word/document.xml', 'docx', 'Office Word 文档容器', ['.docx', '.docm', '.dotx', '.dotm']],
      ['xl/workbook.xml', 'xlsx', 'Office Excel 文档容器', ['.xlsx', '.xlsm', '.xltx', '.xltm']],
      ['ppt/presentation.xml', 'pptx', 'Office PowerPoint 文档容器', ['.pptx', '.pptm', '.potx', '.potm']]
    ].find(([entry]) => names.includes(entry))
    match = office ? [office[1], office[2], '', office[3]] : ['zip', 'ZIP/Office/归档容器', '', ['.zip', '.jar', '.apk', '.docx', '.xlsx', '.pptx', '.nupkg', '.vsix']]
    details = office ? ['有界 ZIP 本地文件头同时包含内容类型与 Office 主文档标记'] : ['仅确定 ZIP 容器；未解压，前缀中缺少足够的文档子类型标记']
  } else if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const subtype = buffer.toString('ascii', 8, 12)
    const riff = { WEBP: ['webp', 'WebP 图片', '', ['.webp']], WAVE: ['wav', 'WAV 音频', '', ['.wav']], 'AVI ': ['avi', 'AVI 视频容器', '', ['.avi']] }
    match = riff[subtype] || null
  }
  if (!match) return null
  const extension = path.extname(filePath).toLowerCase()
  return {
    version: EVIDENCE_VERSION, source: 'file-header', format: match[0], type: match[1], status, confidence,
    extension, extensionConflict: Boolean(extension && !match[3].includes(extension)),
    bytesRead: buffer.length, prefixLimited: Number(fileSize) > buffer.length,
    details
  }
}

module.exports = { EVIDENCE_VERSION, MAX_PREFIX_BYTES, identifyPrefix, zipEntryNames }
