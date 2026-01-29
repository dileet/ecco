import type { PrivateKey } from '@libp2p/interface'
import type { Invoice, PaymentProof, EscrowAgreement, StreamingAgreement, SignedInvoice, PaymentLedgerEntry } from '../types'
import type { WalletState } from './wallet'
import type { BatchSettlementResult } from '../agent/types'
import { verifyPayment as verifyPaymentOnChain, getAddress, batchSettle } from './wallet'
import { releaseEscrowMilestone, recordStreamingTick } from './payment-processor'
import {
  writeEscrowAgreement,
  updateEscrowAgreementIfUnchanged,
  writeStreamingChannel,
  updateStreamingChannel,
  isPaymentProofProcessed,
  markPaymentProofProcessed,
  writeTimedOutPayment,
  getTimedOutPayment,
  processPaymentRecovery,
  createAndDistributeSwarmSplit,
  writePaymentLedgerEntry,
  updatePaymentLedgerEntry,
} from '../storage'
import type { MessageContext, PricingConfig, PaymentHelpers, RecordTokensOptions, RecordTokensResult, DistributeToSwarmOptions, DistributeToSwarmResult, ReleaseMilestoneOptions } from '../agent/types'
import { createSwarmSplit, distributeSwarmSplit } from './payment-processor'
import { bigintToDecimalString, toWei, validateMilestonesTotal, validateStreamingRate, validateEscrowAmounts } from '../utils/wei'
import { createInvoice, createSignedInvoice } from '../agent/invoice-factory'

const MAX_INVOICE_QUEUE = 1000

export interface PaymentState {
  escrowAgreements: Map<string, EscrowAgreement>
  streamingAgreements: Map<string, StreamingAgreement>
  pendingPayments: Map<string, PendingPayment>
  invoiceQueue: Invoice[]
}

interface PendingPayment {
  invoice: Invoice
  resolve: (proof: PaymentProof) => void
  reject: (error: Error) => void
}

function takePendingPayment(paymentState: PaymentState, invoiceId: string): PendingPayment | undefined {
  const pending = paymentState.pendingPayments.get(invoiceId)
  if (pending) {
    paymentState.pendingPayments.delete(invoiceId)
  }
  return pending
}

function timedOutPaymentToInvoice(timedOut: {
  invoiceId: string
  jobId: string
  chainId: number
  amount: string
  token: string
  tokenAddress: string | null
  recipient: string
  validUntil: number
}): Invoice {
  return {
    id: timedOut.invoiceId,
    jobId: timedOut.jobId,
    chainId: timedOut.chainId,
    amount: timedOut.amount,
    token: timedOut.token,
    tokenAddress: timedOut.tokenAddress as `0x${string}` | null,
    recipient: timedOut.recipient,
    validUntil: timedOut.validUntil,
    signature: null,
    publicKey: null,
  }
}

async function verifyAndProcessPayment(
  wallet: WalletState,
  proof: PaymentProof,
  invoice: Invoice,
  onSuccess: () => Promise<void>
): Promise<boolean> {
  let valid = false
  try {
    valid = await verifyPaymentOnChain(wallet, proof, invoice)
  } catch {
    return false
  }
  if (!valid) return false
  await onSuccess()
  return true
}

export function createPaymentHelpers(
  wallet: WalletState | null,
  paymentState: PaymentState,
  signingKey?: PrivateKey
): PaymentHelpers {
  const requireWallet = (): WalletState => {
    if (!wallet) throw new Error('Wallet not configured for payments')
    return wallet
  }

  const createInvoiceForJob = async (
    jobId: string,
    chainId: number,
    amount: string,
    token: string
  ): Promise<Invoice | SignedInvoice> => {
    const w = requireWallet()
    return createSignedInvoice(
      { jobId, chainId, amount, token, recipient: getAddress(w) },
      signingKey
    )
  }

  const createInvoiceFromCtx = async (
    ctx: MessageContext,
    pricing: PricingConfig
  ): Promise<Invoice | SignedInvoice> => {
    const amount = pricing.amount ? toWei(pricing.amount) : 0n
    return createInvoiceForJob(
      ctx.message.id,
      pricing.chainId,
      bigintToDecimalString(amount),
      pricing.token ?? 'ETH'
    )
  }

  const requirePayment = async (
    ctx: MessageContext,
    pricing: PricingConfig,
    options?: { signal?: AbortSignal }
  ): Promise<PaymentProof> => {
    requireWallet()
    const invoice = await createInvoiceFromCtx(ctx, pricing)

    const ledgerEntry: PaymentLedgerEntry = {
      id: invoice.id,
      type: 'standard',
      status: 'pending',
      chainId: invoice.chainId,
      token: invoice.token,
      amount: invoice.amount,
      recipient: invoice.recipient,
      payer: ctx.message.from,
      jobId: invoice.jobId,
      createdAt: Date.now(),
      txHash: null,
      settledAt: null,
      metadata: null,
    }
    await writePaymentLedgerEntry(ledgerEntry)
    await ctx.reply({ invoice }, 'invoice')

    return new Promise((resolve, reject) => {
      const onAbort = async () => {
        const pending = takePendingPayment(paymentState, invoice.id)
        if (!pending) return
        await writeTimedOutPayment(pending.invoice, Date.now())
        reject(new Error('Payment aborted'))
      }

      if (options?.signal?.aborted) {
        void onAbort()
        return
      }

      options?.signal?.addEventListener('abort', () => void onAbort(), { once: true })

      paymentState.pendingPayments.set(invoice.id, { invoice, resolve, reject })
    })
  }

  const verifyPayment = async (proof: PaymentProof): Promise<boolean> => {
    const w = requireWallet()
    if (await isPaymentProofProcessed(proof.txHash, proof.chainId)) return false

    const pending = takePendingPayment(paymentState, proof.invoiceId)
    if (pending) {
      let valid = false
      try {
        valid = await verifyPaymentOnChain(w, proof, pending.invoice)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
        return false
      }
      if (!valid) {
        pending.reject(new Error('Payment verification failed'))
        return false
      }

      await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
      await updatePaymentLedgerEntry({
        id: proof.invoiceId,
        type: 'standard',
        status: 'settled',
        chainId: proof.chainId,
        token: pending.invoice.token,
        amount: pending.invoice.amount,
        recipient: pending.invoice.recipient,
        payer: '',
        jobId: pending.invoice.jobId,
        createdAt: Date.now(),
        settledAt: Date.now(),
        txHash: proof.txHash,
        metadata: null,
      })
      pending.resolve(proof)
      return true
    }

    const timedOut = await getTimedOutPayment(proof.invoiceId)
    if (timedOut && timedOut.status === 'pending') {
      const timedOutInvoice = timedOutPaymentToInvoice(timedOut)
      const success = await verifyAndProcessPayment(w, proof, timedOutInvoice, async () => {
        await processPaymentRecovery(proof.txHash, proof.chainId, proof.invoiceId)
        await updatePaymentLedgerEntry({
          id: proof.invoiceId,
          type: 'standard',
          status: 'settled',
          chainId: timedOut.chainId,
          token: timedOut.token,
          amount: timedOut.amount,
          recipient: timedOut.recipient,
          payer: '',
          jobId: timedOut.jobId,
          createdAt: timedOut.timedOutAt,
          settledAt: Date.now(),
          txHash: proof.txHash,
          metadata: null,
        })
      })
      return success
    }

    return false
  }

  const releaseMilestone = async (
    ctx: MessageContext,
    milestoneId: string,
    options?: ReleaseMilestoneOptions
  ): Promise<void> => {
    const jobId = ctx.message.id
    const currentAgreement = paymentState.escrowAgreements.get(jobId)
    if (!currentAgreement) throw new Error(`No escrow agreement found for job ${jobId}`)

    if (currentAgreement.requiresApproval) {
      if (!currentAgreement.approver) throw new Error(`Escrow agreement requires approval but no approver is set`)
      if (ctx.message.from !== currentAgreement.approver) {
        throw new Error(`Unauthorized: only the designated approver can release milestones`)
      }
    }

    const updatedAgreement = releaseEscrowMilestone(currentAgreement, milestoneId)
    const didUpdate = await updateEscrowAgreementIfUnchanged(updatedAgreement, currentAgreement.milestones)
    if (!didUpdate) {
      const latestMilestone = paymentState.escrowAgreements.get(jobId)?.milestones.find((m) => m.id === milestoneId)
      if (latestMilestone?.released) throw new Error(`Milestone ${milestoneId} has already been released`)
      throw new Error(`Escrow agreement ${currentAgreement.id} was updated concurrently`)
    }

    paymentState.escrowAgreements.set(jobId, updatedAgreement)

    const shouldSendInvoice = options?.sendInvoice !== false
    const milestone = updatedAgreement.milestones.find((m) => m.id === milestoneId)
    if (shouldSendInvoice && milestone && wallet) {
      const invoice = await createInvoiceForJob(updatedAgreement.jobId, updatedAgreement.chainId, milestone.amount, updatedAgreement.token)
      await ctx.reply(invoice, 'invoice')
    }
  }

  const sendEscrowInvoice = async (ctx: MessageContext): Promise<void> => {
    const agreement = paymentState.escrowAgreements.get(ctx.message.id)
    if (!agreement || !wallet) return

    const releasedMilestones = agreement.milestones.filter((m) => m.released)
    if (releasedMilestones.length === 0) return

    const totalAmount = releasedMilestones.reduce((sum, m) => sum + toWei(m.amount), 0n)
    const invoice = await createInvoiceForJob(agreement.jobId, agreement.chainId, bigintToDecimalString(totalAmount), agreement.token)
    await ctx.reply(invoice, 'invoice')
  }

  const recordTokens = async (
    ctx: MessageContext,
    count: number,
    options?: RecordTokensOptions
  ): Promise<RecordTokensResult> => {
    const channelId = options?.channelId ?? ctx.message.id
    let agreement = paymentState.streamingAgreements.get(channelId)

    if (!agreement) {
      if (!options?.pricing) throw new Error(`No streaming agreement found for channel ${channelId} and no pricing config provided`)
      const w = requireWallet()

      agreement = {
        id: crypto.randomUUID(),
        jobId: channelId,
        payer: ctx.message.from,
        recipient: getAddress(w),
        chainId: options.pricing.chainId,
        token: options.pricing.token ?? 'ETH',
        ratePerToken: bigintToDecimalString(options.pricing.ratePerToken ? toWei(options.pricing.ratePerToken) : 0n),
        accumulatedAmount: '0',
        lastTick: Date.now(),
        status: 'active',
        createdAt: Date.now(),
        closedAt: null,
      }
      await writeStreamingChannel(agreement)
      paymentState.streamingAgreements.set(channelId, agreement)
    }

    const { agreement: updatedAgreement, amountOwed } = recordStreamingTick(agreement, count)
    await updateStreamingChannel(updatedAgreement)
    paymentState.streamingAgreements.set(channelId, updatedAgreement)

    let invoiceSent = false
    if (options?.autoInvoice && parseFloat(amountOwed) > 0) {
      const invoice = await createSignedInvoice(
        { jobId: channelId, chainId: updatedAgreement.chainId, amount: amountOwed, token: updatedAgreement.token, recipient: updatedAgreement.recipient },
        signingKey
      )
      await ctx.reply(invoice, 'invoice')
      invoiceSent = true
    }

    const ratePerToken = parseFloat(updatedAgreement.ratePerToken)
    const totalTokens = ratePerToken > 0 ? Math.round(parseFloat(updatedAgreement.accumulatedAmount) / ratePerToken) : 0

    return { channelId, tokens: count, totalTokens, amountOwed, totalAmount: updatedAgreement.accumulatedAmount, invoiceSent }
  }

  const sendStreamingInvoice = async (ctx: MessageContext, channelId: string): Promise<void> => {
    const agreement = paymentState.streamingAgreements.get(channelId)
    if (!agreement || parseFloat(agreement.accumulatedAmount) <= 0) return

    const invoice = await createSignedInvoice(
      { jobId: channelId, chainId: agreement.chainId, amount: agreement.accumulatedAmount, token: agreement.token, recipient: agreement.recipient },
      signingKey
    )
    await ctx.reply({ invoice }, 'invoice')
  }

  const closeStreamingChannel = async (channelId: string): Promise<void> => {
    const agreement = paymentState.streamingAgreements.get(channelId)
    if (!agreement) return

    const closedAgreement: StreamingAgreement = { ...agreement, status: 'closed', closedAt: Date.now() }
    await updateStreamingChannel(closedAgreement)

    await updatePaymentLedgerEntry({
      id: agreement.id,
      type: 'streaming',
      status: 'settled',
      chainId: agreement.chainId,
      token: agreement.token,
      amount: agreement.accumulatedAmount,
      recipient: agreement.recipient,
      payer: agreement.payer,
      jobId: agreement.jobId,
      createdAt: agreement.createdAt,
      settledAt: Date.now(),
      txHash: null,
      metadata: null,
    })

    paymentState.streamingAgreements.delete(channelId)
  }

  const distributeToSwarm = async (jobId: string, options: DistributeToSwarmOptions): Promise<DistributeToSwarmResult> => {
    const agentId = wallet ? getAddress(wallet) : 'unknown'
    const swarmSplit = createSwarmSplit(jobId, agentId, options.totalAmount, options.chainId, options.token ?? 'ETH', options.participants)
    const distribution = distributeSwarmSplit(swarmSplit)
    await createAndDistributeSwarmSplit(swarmSplit, distribution.split)

    for (const invoice of distribution.invoices) {
      const ledgerEntry: PaymentLedgerEntry = {
        id: invoice.id,
        type: 'swarm',
        status: 'pending',
        chainId: options.chainId,
        token: options.token ?? 'ETH',
        amount: invoice.amount,
        recipient: invoice.recipient,
        payer: agentId,
        jobId,
        createdAt: Date.now(),
        txHash: null,
        settledAt: null,
        metadata: { swarmSplitId: swarmSplit.id },
      }
      await writePaymentLedgerEntry(ledgerEntry)
    }

    const availableSlots = MAX_INVOICE_QUEUE - paymentState.invoiceQueue.length
    if (distribution.invoices.length > availableSlots) {
      throw new Error(`Invoice queue limit would be exceeded. Available: ${availableSlots}, needed: ${distribution.invoices.length}. Call settleAll() first.`)
    }

    for (const invoice of distribution.invoices) {
      const signedInvoice = await createSignedInvoice(
        { jobId: invoice.jobId, chainId: invoice.chainId, amount: invoice.amount, token: invoice.token, recipient: invoice.recipient },
        signingKey
      )
      paymentState.invoiceQueue.push(signedInvoice)
    }

    return { splitId: swarmSplit.id, invoicesSent: distribution.invoices.length, totalAmount: options.totalAmount }
  }

  const queueInvoice = (invoice: Invoice): void => {
    if (paymentState.invoiceQueue.length >= MAX_INVOICE_QUEUE) {
      throw new Error(`Invoice queue limit reached (${MAX_INVOICE_QUEUE}). Call settleAll() to process pending invoices.`)
    }
    paymentState.invoiceQueue.push(invoice)
  }

  const settleAll = async (): Promise<BatchSettlementResult[]> => {
    const w = requireWallet()
    if (paymentState.invoiceQueue.length === 0) return []
    const invoices = [...paymentState.invoiceQueue]
    paymentState.invoiceQueue = []
    return batchSettle(w, invoices)
  }

  const getPendingInvoices = (): Invoice[] => [...paymentState.invoiceQueue]

  return {
    requirePayment,
    createInvoice: createInvoiceFromCtx,
    verifyPayment,
    releaseMilestone,
    sendEscrowInvoice,
    recordTokens,
    sendStreamingInvoice,
    closeStreamingChannel,
    distributeToSwarm,
    queueInvoice,
    settleAll,
    getPendingInvoices,
  }
}

export function createPaymentState(): PaymentState {
  return {
    escrowAgreements: new Map(),
    streamingAgreements: new Map(),
    pendingPayments: new Map(),
    invoiceQueue: [],
  }
}

export async function handlePaymentProof(
  paymentState: PaymentState,
  proof: PaymentProof,
  wallet: WalletState | null
): Promise<boolean> {
  if (await isPaymentProofProcessed(proof.txHash, proof.chainId)) return false
  if (!wallet) return false

  const pending = takePendingPayment(paymentState, proof.invoiceId)
  if (pending) {
    let valid = false
    try {
      valid = await verifyPaymentOnChain(wallet, proof, pending.invoice)
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      return false
    }

    if (!valid) {
      pending.reject(new Error('Payment verification failed'))
      return false
    }

    await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
    pending.resolve(proof)
    return true
  }

  const timedOut = await getTimedOutPayment(proof.invoiceId)
  if (timedOut && timedOut.status === 'pending') {
    const timedOutInvoice = timedOutPaymentToInvoice(timedOut)
    return verifyAndProcessPayment(wallet, proof, timedOutInvoice, async () => {
      await processPaymentRecovery(proof.txHash, proof.chainId, proof.invoiceId)
    })
  }

  return false
}

export async function setupEscrowAgreement(
  paymentState: PaymentState,
  jobId: string,
  payer: string,
  recipient: string,
  pricing: PricingConfig
): Promise<EscrowAgreement> {
  const milestones = pricing.milestones ?? []
  if (milestones.length > 0) {
    validateEscrowAmounts(milestones)
    if (pricing.amount) validateMilestonesTotal(milestones, pricing.amount)
  }

  const agreement: EscrowAgreement = {
    id: crypto.randomUUID(),
    jobId,
    payer,
    recipient,
    chainId: pricing.chainId,
    token: pricing.token ?? 'ETH',
    totalAmount: bigintToDecimalString(pricing.amount ? toWei(pricing.amount) : 0n),
    milestones: milestones.map((m) => ({
      id: m.id,
      amount: bigintToDecimalString(toWei(m.amount)),
      released: false,
      status: 'pending' as const,
      releasedAt: null,
    })),
    status: 'locked',
    createdAt: Date.now(),
    requiresApproval: pricing.requiresApproval ?? true,
    approver: pricing.approver ?? payer,
  }

  try {
    await writeEscrowAgreement(agreement)
  } catch (error) {
    throw new Error(`Failed to write escrow agreement: ${error instanceof Error ? error.message : String(error)}`)
  }
  paymentState.escrowAgreements.set(jobId, agreement)

  const ledgerEntry: PaymentLedgerEntry = {
    id: agreement.id,
    type: 'escrow',
    status: 'pending',
    chainId: agreement.chainId,
    token: agreement.token,
    amount: agreement.totalAmount,
    recipient: agreement.recipient,
    payer: agreement.payer,
    jobId: agreement.jobId,
    createdAt: agreement.createdAt,
    txHash: null,
    settledAt: null,
    metadata: null,
  }
  try {
    await writePaymentLedgerEntry(ledgerEntry)
  } catch (error) {
    paymentState.escrowAgreements.delete(jobId)
    throw new Error(`Failed to write payment ledger entry: ${error instanceof Error ? error.message : String(error)}`)
  }

  return agreement
}

export async function setupStreamingAgreement(
  paymentState: PaymentState,
  jobId: string,
  payer: string,
  recipient: string,
  pricing: PricingConfig
): Promise<StreamingAgreement> {
  validateStreamingRate(pricing.ratePerToken)

  const agreement: StreamingAgreement = {
    id: crypto.randomUUID(),
    jobId,
    payer,
    recipient,
    chainId: pricing.chainId,
    token: pricing.token ?? 'ETH',
    ratePerToken: bigintToDecimalString(pricing.ratePerToken ? toWei(pricing.ratePerToken) : 0n),
    accumulatedAmount: '0',
    lastTick: Date.now(),
    status: 'active',
    createdAt: Date.now(),
    closedAt: null,
  }

  try {
    await writeStreamingChannel(agreement)
  } catch (error) {
    throw new Error(`Failed to write streaming channel: ${error instanceof Error ? error.message : String(error)}`)
  }
  paymentState.streamingAgreements.set(jobId, agreement)

  const ledgerEntry: PaymentLedgerEntry = {
    id: agreement.id,
    type: 'streaming',
    status: 'streaming',
    chainId: agreement.chainId,
    token: agreement.token,
    amount: agreement.accumulatedAmount,
    recipient: agreement.recipient,
    payer: agreement.payer,
    jobId: agreement.jobId,
    createdAt: agreement.createdAt,
    txHash: null,
    settledAt: null,
    metadata: null,
  }
  try {
    await writePaymentLedgerEntry(ledgerEntry)
  } catch (error) {
    paymentState.streamingAgreements.delete(jobId)
    throw new Error(`Failed to write payment ledger entry: ${error instanceof Error ? error.message : String(error)}`)
  }

  return agreement
}
