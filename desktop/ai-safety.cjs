/** @param {unknown} value */
function redactSensitiveText(value) {
  return String(value || '')
    .replace(/-----BEGIN[^\r\n]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END[^\r\n]{0,80}PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '$1-[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*["']?\s*:\s*)[|>][+\-\d]*[^\S\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, '$1[REDACTED]')
    // Quoted values can contain whitespace, escaped quotes and line breaks.
    // Also redact an unfinished quoted value: evidence prefixes may end mid-secret.
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\r\n,}\]]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}
module.exports = { redactSensitiveText }
