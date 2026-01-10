import { z } from 'zod'

export const PaymentProofSchema = z.object({
  invoiceId: z.string(),
  txHash: z.string(),
  chainId: z.number(),
})

export const InvoiceSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  chainId: z.number(),
  amount: z.string(),
  token: z.string(),
  tokenAddress: z.string().nullable().transform((v) => v as `0x${string}` | null),
  recipient: z.string(),
  validUntil: z.number(),
  signature: z.string().nullable(),
  publicKey: z.string().nullable(),
})

export const StreamingTickSchema = z.object({
  channelId: z.string().optional(),
  tokensGenerated: z.number().int().nonnegative(),
})

export const EscrowApprovalSchema = z.object({
  jobId: z.string(),
  milestoneId: z.string(),
})

export type PaymentProof = z.infer<typeof PaymentProofSchema>
export type InvoiceData = z.infer<typeof InvoiceSchema>
export type StreamingTick = z.infer<typeof StreamingTickSchema>
export type EscrowApproval = z.infer<typeof EscrowApprovalSchema>
