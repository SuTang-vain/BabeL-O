export type TruncatedOutput = {
  value: unknown
  truncated: boolean
  originalBytes?: number
  maxBytes?: number
}

export function truncateToolOutput(
  output: unknown,
  maxBytes: number,
): TruncatedOutput {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { value: output, truncated: false }
  }

  if (typeof output === 'string') {
    return truncateString(output, maxBytes)
  }

  const json = JSON.stringify(output)
  const jsonBytes = Buffer.byteLength(json, 'utf8')
  if (jsonBytes <= maxBytes) {
    return { value: output, truncated: false }
  }

  return {
    value: {
      truncated: true,
      originalBytes: jsonBytes,
      preview: truncateUtf8(json, maxBytes),
    },
    truncated: true,
    originalBytes: jsonBytes,
    maxBytes,
  }
}

function truncateString(value: string, maxBytes: number): TruncatedOutput {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= maxBytes) return { value, truncated: false }
  return {
    value: truncateUtf8(value, maxBytes),
    truncated: true,
    originalBytes: bytes,
    maxBytes,
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  return buffer.subarray(0, maxBytes).toString('utf8')
}
