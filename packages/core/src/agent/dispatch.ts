import type { Message, MessageType } from '../types'
import type { WalletState } from '../payments/wallet'
import { getAddress } from '../payments/wallet'
import { isSignedInvoice, verifyInvoice } from '../payments/invoice-signing'
import { getExpectedInvoice, deleteExpectedInvoice } from '../storage'
import { debug } from '../utils'
import type { Agent, MessageContext, MessageHandler, StreamChunk, PricingConfig, PaymentHelpers } from './types'
import { handlePaymentProof, setupEscrowAgreement, type PaymentState } from '../payments/payment-helpers'
import {
  PaymentProofSchema,
  InvoiceSchema,
  StreamingTickSchema,
  EscrowApprovalSchema,
} from './schemas'

export interface MessageDispatcherConfig {
  getAgent: () => Agent | null
  paymentState: PaymentState
  walletState: WalletState | null
  pricing?: PricingConfig
  payments: PaymentHelpers
  messageHandler?: MessageHandler
}

interface BaseMessageContext {
  reply: (payload: unknown, type?: MessageType) => Promise<void>
}

function getExplicitTokens(payload: unknown): number | null {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.tokens === 'number') {
      return obj.tokens
    }
  }
  return null
}

export function createMessageDispatcher(config: MessageDispatcherConfig) {
  const { getAgent, paymentState, walletState, pricing, payments, messageHandler } = config

  return async (msg: Message, baseCtx: BaseMessageContext): Promise<void> => {
    if (msg.type === 'submit-payment-proof') {
      const proofResult = PaymentProofSchema.safeParse(msg.payload)
      if (proofResult.success) {
        await handlePaymentProof(paymentState, proofResult.data, walletState)
      }
      return
    }

    if (msg.type === 'invoice') {
      const payload = msg.payload as { invoice?: unknown; response?: { invoice?: unknown } | unknown }
      const invoiceData = payload?.invoice ?? (payload?.response as { invoice?: unknown })?.invoice ?? payload?.response ?? msg.payload
      const invoiceResult = InvoiceSchema.safeParse(invoiceData)
      if (invoiceResult.success) {
        const invoice = invoiceResult.data
        if (isSignedInvoice(invoice)) {
          const { valid } = await verifyInvoice(invoice)
          if (!valid) {
            debug('invoice', `Rejected invoice ${invoice.id}: invalid signature`)
            return
          }
        }
        const expectedInvoice = await getExpectedInvoice(invoice.jobId)
        if (!expectedInvoice) {
          debug('invoice', `Rejected invoice ${invoice.id}: no expected invoice for job ${invoice.jobId}`)
          return
        }
        if (msg.from !== expectedInvoice.expectedRecipient) {
          debug('invoice', `Rejected invoice ${invoice.id}: sender ${msg.from} does not match expected recipient ${expectedInvoice.expectedRecipient}`)
          return
        }
        await deleteExpectedInvoice(invoice.jobId)
        payments.queueInvoice(invoice)
      }
    }

    if (msg.type === 'streaming-tick' && pricing?.type === 'streaming') {
      const tickResult = StreamingTickSchema.safeParse(msg.payload)
      if (tickResult.success) {
        const ctx: MessageContext = {
          agent: getAgent()!,
          message: msg,
          reply: baseCtx.reply,
          streamResponse: async () => {},
        }
        await payments.recordTokens(ctx, tickResult.data.tokensGenerated, {
          channelId: tickResult.data.channelId,
          pricing: pricing,
          autoInvoice: true,
        })
      }
    }

    if (msg.type === 'agent-request' && pricing?.type === 'escrow' && walletState) {
      await setupEscrowAgreement(
        paymentState,
        msg.id,
        msg.from,
        getAddress(walletState),
        pricing
      )
    }

    if (msg.type === 'escrow-approval') {
      const approvalResult = EscrowApprovalSchema.safeParse(msg.payload)
      if (approvalResult.success) {
        const { jobId, milestoneId } = approvalResult.data
        const agreement = paymentState.escrowAgreements.get(jobId)
        if (agreement) {
          const approvalCtx: MessageContext = {
            agent: getAgent()!,
            message: msg,
            reply: baseCtx.reply,
            streamResponse: async () => {},
          }
          await payments.releaseMilestone(approvalCtx, milestoneId)
        }
      }
      return
    }

    if (messageHandler && msg.type === 'agent-request') {
      const channelId = msg.id

      const wrappedReply = async (payload: unknown, type?: MessageType) => {
        if (pricing?.type === 'streaming' && type !== 'invoice') {
          const tokens = getExplicitTokens(payload)
          if (tokens !== null && tokens > 0) {
            const tempCtx: MessageContext = {
              agent: getAgent()!,
              message: msg,
              reply: baseCtx.reply,
              streamResponse: async () => {},
            }
            await payments.recordTokens(tempCtx, tokens, {
              channelId,
              pricing: pricing,
              autoInvoice: true,
            })
          }
        }
        await baseCtx.reply({ requestId: msg.id, response: payload }, type ?? 'agent-response')
      }

      const streamResponse = async (
        generator: AsyncGenerator<StreamChunk> | (() => AsyncGenerator<StreamChunk>)
      ) => {
        const gen = typeof generator === 'function' ? generator() : generator
        let fullResponse = ''
        let totalTokens = 0

        try {
          for await (const chunk of gen) {
            fullResponse += chunk.text

            if (pricing?.type === 'streaming' && chunk.tokens && chunk.tokens > 0) {
              totalTokens += chunk.tokens
              const tempCtx: MessageContext = {
                agent: getAgent()!,
                message: msg,
                reply: baseCtx.reply,
                streamResponse: async () => {},
              }
              await payments.recordTokens(tempCtx, chunk.tokens, {
                channelId,
                pricing: pricing,
                autoInvoice: false,
              })
            }

            await baseCtx.reply({ requestId: msg.id, chunk: chunk.text, partial: true }, 'stream-chunk')
          }

          if (pricing?.type === 'streaming' && totalTokens > 0) {
            const tempCtx: MessageContext = {
              agent: getAgent()!,
              message: msg,
              reply: baseCtx.reply,
              streamResponse: async () => {},
            }
            await payments.sendStreamingInvoice(tempCtx, channelId)
          }

          await baseCtx.reply({ requestId: msg.id, text: fullResponse, complete: true }, 'stream-complete')
          await baseCtx.reply({ requestId: msg.id, response: { text: fullResponse, finishReason: 'stop' } }, 'agent-response')
        } finally {
          if (gen.return) {
            await gen.return(undefined)
          }
        }
      }

      const ctx: MessageContext = {
        agent: getAgent()!,
        message: msg,
        reply: wrappedReply,
        streamResponse,
      }
      await messageHandler(msg, ctx)
    }
  }
}
