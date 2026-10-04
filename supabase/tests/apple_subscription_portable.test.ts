import 'npm:reflect-metadata@0.2.2'
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14'
import {
  BasicConstraintsExtension,
  Extension,
  X509CertificateGenerator,
} from 'npm:@peculiar/x509@2.0.0'
import { CompactSign } from 'https://esm.sh/jose@5.6.3'
import { verifyAppleSignedTransactionPortable } from '../functions/_shared/apple_subscription_portable.ts'

Deno.test('portable historical verifier accepts a trusted signature and rejects tampering', async () => {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const
  const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' } as const
  const rootKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const intermediateKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const leafKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const notBefore = new Date(Date.now() - 60_000)
  const notAfter = new Date(Date.now() + 86_400_000)
  const root = await X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root', keys: rootKeys, signingAlgorithm, notBefore, notAfter,
    extensions: [new BasicConstraintsExtension(true, 2, true)],
  })
  const intermediate = await X509CertificateGenerator.create({
    subject: 'CN=Test Intermediate', issuer: root.subject,
    publicKey: intermediateKeys.publicKey, signingKey: rootKeys.privateKey,
    signingAlgorithm, notBefore, notAfter,
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new Extension('1.2.840.113635.100.6.2.1', false, new Uint8Array([5, 0])),
    ],
  })
  const leaf = await X509CertificateGenerator.create({
    subject: 'CN=Test Transaction', issuer: intermediate.subject,
    publicKey: leafKeys.publicKey, signingKey: intermediateKeys.privateKey,
    signingAlgorithm, notBefore, notAfter,
    extensions: [new Extension('1.2.840.113635.100.6.11.1', false, new Uint8Array([5, 0]))],
  })
  const payload = {
    bundleId: 'com.kingboard.app', environment: 'Sandbox',
    originalTransactionId: '12345', productId: 'com.kingboard.app.monthly_basic',
    expiresDate: Date.now() + 86_400_000, signedDate: Date.now(),
  }
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({
      alg: 'ES256', x5c: [leaf, intermediate, root].map((cert) => cert.toString('base64')),
    })
    .sign(leafKeys.privateKey)
  const trustedRoots = [new Uint8Array(root.rawData)]
  const verified = await verifyAppleSignedTransactionPortable(
    jws, 'com.kingboard.app', 'Sandbox', trustedRoots,
  )
  assertEquals(verified.originalTransactionId, '12345')

  const parts = jws.split('.')
  const tampered = `${parts[0]}.${parts[1]}.${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`
  await assertRejects(() => verifyAppleSignedTransactionPortable(
    tampered, 'com.kingboard.app', 'Sandbox', trustedRoots,
  ))
  await assertRejects(() => verifyAppleSignedTransactionPortable(
    jws, 'com.example.invalid', 'Sandbox', trustedRoots,
  ))
  await assertRejects(() => verifyAppleSignedTransactionPortable(
    jws, 'com.kingboard.app', 'Sandbox', [new Uint8Array([1, 2, 3])],
  ))
  assert(jws.length > 0)
})
