import { Buffer } from 'node:buffer'
import { X509Certificate } from 'node:crypto'

export function installX509ToStringCompatibility(trustedCertificate: Uint8Array): void {
  const probe = new X509Certificate(trustedCertificate)
  try {
    probe.toString()
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('X509Certificate.prototype.toString') &&
        !message.includes('ERR_NOT_IMPLEMENTED')) {
      throw error
    }
  }

  const prototype = X509Certificate.prototype as X509Certificate & {
    toString: () => string
    raw: Uint8Array
  }
  Object.defineProperty(prototype, 'toString', {
    configurable: true,
    writable: true,
    value(this: X509Certificate & { raw: Uint8Array }): string {
      const encoded = Buffer.from(this.raw).toString('base64')
      const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? ''
      return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
    },
  })
}
