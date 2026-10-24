import 'npm:reflect-metadata@0.2.2'
import { BasicConstraintsExtension, X509Certificate } from 'npm:@peculiar/x509@2.0.0'
import { compactVerify, importSPKI } from 'https://esm.sh/jose@5.6.3'

type AppleTransaction = {
  bundleId?: string
  environment?: string
  originalTransactionId?: string
  productId?: string
  expiresDate?: number
  revocationDate?: number
  signedDate?: number
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

function validAt(certificate: X509Certificate, date: Date): boolean {
  return certificate.notBefore.getTime() <= date.getTime() + 60_000 &&
    certificate.notAfter.getTime() >= date.getTime() - 60_000
}

export async function verifyAppleSignedTransactionPortable(
  jws: string,
  expectedBundleId: string,
  expectedEnvironment: string,
  trustedRoots: readonly Uint8Array[],
): Promise<AppleTransaction> {
  if (jws.length === 0 || jws.length > 64_000 || jws.split('.').length !== 3) {
    throw new Error('invalid_jws_shape')
  }
  const [encodedHeader, encodedPayload] = jws.split('.')
  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader))) as {
    alg?: string
    x5c?: string[]
  }
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3 ||
      header.x5c.some((value) => typeof value !== 'string' || value.length > 8_000)) {
    throw new Error('invalid_jws_header')
  }
  const [leaf, intermediate, root] = header.x5c.map((value) =>
    new X509Certificate(Uint8Array.from(atob(value), (character) => character.charCodeAt(0))))
  const pinnedRoot = new Uint8Array(root.rawData)
  if (!trustedRoots.some((trusted) => sameBytes(trusted, pinnedRoot))) {
    throw new Error('untrusted_apple_root')
  }

  // The date is untrusted until the JWS signature is checked, so it is used
  // only to validate this already-pinned certificate chain.
  const unverified = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as AppleTransaction
  const signedDate = unverified.signedDate
  if (typeof signedDate !== 'number' || !Number.isFinite(signedDate) || signedDate <= 0 ||
      signedDate > Date.now() + 60_000) {
    throw new Error('invalid_signed_date')
  }
  const date = new Date(signedDate)
  if (leaf.issuer !== intermediate.subject || intermediate.issuer !== root.subject ||
      ![leaf, intermediate, root].every((certificate) => validAt(certificate, date)) ||
      intermediate.getExtension(BasicConstraintsExtension)?.ca !== true ||
      !leaf.extensions.some((extension) => extension.type === '1.2.840.113635.100.6.11.1') ||
      !intermediate.extensions.some((extension) => extension.type === '1.2.840.113635.100.6.2.1') ||
      !await leaf.verify({ publicKey: intermediate.publicKey, date }) ||
      !await intermediate.verify({ publicKey: root.publicKey, date })) {
    throw new Error('invalid_apple_certificate_chain')
  }

  const publicKey = await importSPKI(leaf.publicKey.toString(), 'ES256')
  const verified = await compactVerify(jws, publicKey)
  const transaction = JSON.parse(new TextDecoder().decode(verified.payload)) as AppleTransaction
  if (transaction.bundleId !== expectedBundleId ||
      transaction.environment !== expectedEnvironment ||
      transaction.signedDate !== signedDate) {
    throw new Error('signed_transaction_mismatch')
  }
  return transaction
}
