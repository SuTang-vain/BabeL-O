export function isLocalHost(h: string): boolean {
  const normalized = h.toLowerCase().trim()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

export function validateSecurityConfig(host: string, apiKey: string | undefined): void {
  if (!isLocalHost(host) && !apiKey) {
    throw new Error(`Security Error: Running Nexus on non-localhost (${host}) requires setting the NEXUS_API_KEY environment variable.`)
  }
}
