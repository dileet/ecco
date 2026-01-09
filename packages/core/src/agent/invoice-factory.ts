import type { PrivateKey } from '@libp2p/interface'
import type { Invoice, SignedInvoice } from '../types'
import { signInvoice } from '../utils/invoice-signing'

export type InvoiceParams = {
  jobId: string
  chainId: number
  amount: string
  token: string
  recipient: string
  validUntilMs?: number
}

export function createInvoice(params: InvoiceParams): Invoice {
  return {
    id: crypto.randomUUID(),
    jobId: params.jobId,
    chainId: params.chainId,
    amount: params.amount,
    token: params.token,
    tokenAddress: null,
    recipient: params.recipient,
    validUntil: Date.now() + (params.validUntilMs ?? 3600000),
    signature: null,
    publicKey: null,
  }
}

export async function createSignedInvoice(
  params: InvoiceParams,
  signingKey: PrivateKey | undefined
): Promise<Invoice | SignedInvoice> {
  const invoice = createInvoice(params)
  if (signingKey) {
    return signInvoice(signingKey, invoice)
  }
  return invoice
}
