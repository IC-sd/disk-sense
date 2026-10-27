function redactSensitiveText(value) {
  return String(value || '')
    .replace(/-----BEGIN[\s\S]{0,80}PRIVATE KEY-----[\s\S]*?-----END[\s\S]{0,80}PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '$1-[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*["']?\s*[:=]\s*["']?)[^"',\s}\]]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}
module.exports = { redactSensitiveText }
