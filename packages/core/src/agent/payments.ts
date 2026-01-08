import type { PrivateKey } from '@libp2p/interface'
import type { Invoice, PaymentProof, EscrowAgreement, StreamingAgreement, SignedInvoice, PaymentLedgerEntry } from '../types'
import type { WalletState } from '../services/wallet'
import { verifyPayment as verifyPaymentOnChain, getAddress, batchSettle } from '../services/wallet'
import type { BatchSettlementResult, WorkRewardOptions, WorkRewardResult, FeeHelpers, FeeCalculation, PayWithFeeResult } from './types'
import { releaseEscrowMilestone, recordStreamingTick } from '../services/payment'
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
import type { MessageContext, PricingConfig, PaymentHelpers, RecordTokensOptions, RecordTokensResult, DistributeToSwarmOptions, DistributeToSwarmResult, ReleaseMilestoneOptions } from './types'
import { createSwarmSplit, distributeSwarmSplit } from '../services/payment'
import { distributeReward, estimateReward, generateJobId } from '../services/work-rewards'
import {
  calculateFee as calculateFeeOnChain,
  collectFee as collectFeeOnChain,
  claimRewards as claimRewardsOnChain,
  getPendingRewards as getPendingRewardsOnChain,
} from '../services/fee-collector'
import { signInvoice } from '../utils/invoice-signing'
import { createAsyncMutex, type AsyncMutex } from '../utils/concurrency'

const MAX_INVOICE_QUEUE = 1000

interface PaymentState {
  escrowAgreements: Map<string, EscrowAgreement>
  streamingAgreements: Map<string, StreamingAgreement>
  streamingLocks: Map<string, AsyncMutex>
  pendingPayments: Map<string, PendingPayment>
  invoiceQueue: Invoice[]
}

interface PendingPayment {
  invoice: Invoice
  resolve: (proof: PaymentProof) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
  mutex: AsyncMutex
  settled: boolean
}

function getStreamingMutex(paymentState: PaymentState, channelId: string): AsyncMutex {
  const existing = paymentState.streamingLocks.get(channelId)
  if (existing) {
    return existing
  }
  const mutex = createAsyncMutex()
  paymentState.streamingLocks.set(channelId, mutex)
  return mutex
}

function clearPendingPayment(paymentState: PaymentState, pending: PendingPayment): void {
  clearTimeout(pending.timeoutId)
  paymentState.pendingPayments.delete(pending.invoice.id)
}

function bigintToDecimalString(value: bigint): string {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 18n) {
    console.warn(`bigintToDecimalString: value ${value} may lose precision when converted to string`)
  }
  const str = value.toString()
  const padded = str.padStart(19, '0')
  const intPart = padded.slice(0, -18) || '0'
  const fracPart = padded.slice(-18).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

function toWei(value: string | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error('toWei: value cannot be negative')
    }
    return value
  }
  if (value.startsWith('-')) {
    throw new Error('toWei: value cannot be negative')
  }
  const [intPart, fracPart = ''] = value.split('.')
  const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18)
  return BigInt(intPart + paddedFrac)
}

function toWeiOrBigint(value: string | bigint): bigint {
  return typeof value === 'bigint' ? value : toWei(value)
}

function validateMilestonesTotal(milestones: Array<{ amount: string | bigint }>, totalAmount: string | bigint): void {
  const total = toWeiOrBigint(totalAmount)
  const sum = milestones.reduce((acc, m) => acc + toWeiOrBigint(m.amount), 0n)
  if (sum !== total) {
    throw new Error(`Milestones sum (${sum}) does not equal total amount (${total})`)
  }
}

function validateStreamingRate(rate: string | bigint | undefined): void {
  if (!rate) return
  const rateWei = toWeiOrBigint(rate)
  if (rateWei <= 0n) {
    throw new Error('Streaming rate must be greater than 0')
  }
}

function validateEscrowAmounts(milestones: Array<{ amount: string | bigint }>): void {
  for (const m of milestones) {
    const amount = toWeiOrBigint(m.amount)
    if (amount <= 0n) {
      throw new Error('Escrow milestone amounts must be greater than 0')
    }
  }
}

export function createPaymentHelpers(
  wallet: WalletState | null,
  paymentState: PaymentState,
  signingKey?: PrivateKey
): PaymentHelpers {
  const createInvoice = async (
    ctx: MessageContext,
    pricing: PricingConfig
  ): Promise<Invoice | SignedInvoice> => {
    if (!wallet) {
      throw new Error('Wallet not configured for payments')
    }

    const amount = pricing.amount ? toWei(pricing.amount) : 0n
    const jobId = ctx.message.id

    const invoice: Invoice = {
      id: crypto.randomUUID(),
      jobId,
      chainId: pricing.chainId,
      amount: bigintToDecimalString(amount),
      token: pricing.token ?? 'ETH',
      recipient: getAddress(wallet),
      validUntil: Date.now() + 3600000,
    }

    if (signingKey) {
      return signInvoice(signingKey, invoice)
    }

    return invoice
  }

  const requirePayment = async (
    ctx: MessageContext,
    pricing: PricingConfig
  ): Promise<PaymentProof> => {
    if (!wallet) {
      throw new Error('Wallet not configured for payments')
    }

    const invoice = await createInvoice(ctx, pricing)

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
    }
    await writePaymentLedgerEntry(ledgerEntry)

    await ctx.reply({ invoice }, 'invoice')

    return new Promise((resolve, reject) => {
      const mutex = createAsyncMutex()
      const handleTimeout = async () => {
        const release = await mutex.acquire()
        try {
          const pending = paymentState.pendingPayments.get(invoice.id)
          if (!pending || pending.settled) {
            return
          }
          pending.settled = true
          await writeTimedOutPayment(pending.invoice, Date.now())
          clearPendingPayment(paymentState, pending)
          reject(new Error('Payment timeout'))
        } finally {
          release()
        }
      }
      const timeoutId = setTimeout(() => {
        void handleTimeout()
      }, 60000)

      paymentState.pendingPayments.set(invoice.id, {
        invoice,
        resolve: (proof: PaymentProof) => {
          resolve(proof)
        },
        reject: (error: Error) => {
          reject(error)
        },
        timeoutId,
        mutex,
        settled: false,
      })
    })
  }

  const verifyPayment = async (proof: PaymentProof): Promise<boolean> => {
    if (!wallet) {
      throw new Error('Wallet not configured for payments')
    }

    const alreadyProcessed = await isPaymentProofProcessed(proof.txHash, proof.chainId)
    if (alreadyProcessed) {
      return false
    }

    const pending = paymentState.pendingPayments.get(proof.invoiceId)
    if (pending) {
      const release = await pending.mutex.acquire()
      try {
        const current = paymentState.pendingPayments.get(proof.invoiceId)
        if (current && !current.settled) {
          let valid = false
          try {
            valid = await verifyPaymentOnChain(wallet, proof, current.invoice)
          } catch (error) {
            current.settled = true
            clearPendingPayment(paymentState, current)
            current.reject(error instanceof Error ? error : new Error(String(error)))
            return false
          }
          if (!valid) {
            return false
          }
          await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
          await updatePaymentLedgerEntry({
            id: proof.invoiceId,
            type: 'standard',
            status: 'settled',
            chainId: proof.chainId,
            token: current.invoice.token,
            amount: current.invoice.amount,
            recipient: current.invoice.recipient,
            payer: '',
            jobId: current.invoice.jobId,
            createdAt: Date.now(),
            settledAt: Date.now(),
            txHash: proof.txHash,
          })
          current.settled = true
          clearPendingPayment(paymentState, current)
          current.resolve(proof)
          return true
        }
      } finally {
        release()
      }
    }

    const timedOut = await getTimedOutPayment(proof.invoiceId)
    if (timedOut && timedOut.status === 'pending') {
      try {
        const valid = await verifyPaymentOnChain(wallet, proof, timedOut.invoice)
        if (valid) {
          await processPaymentRecovery(proof.txHash, proof.chainId, proof.invoiceId)
          await updatePaymentLedgerEntry({
            id: proof.invoiceId,
            type: 'standard',
            status: 'settled',
            chainId: proof.chainId,
            token: timedOut.invoice.token,
            amount: timedOut.invoice.amount,
            recipient: timedOut.invoice.recipient,
            payer: '',
            jobId: timedOut.invoice.jobId,
            createdAt: timedOut.timedOutAt,
            settledAt: Date.now(),
            txHash: proof.txHash,
          })
          return true
        }
        return false
      } catch {
        return false
      }
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

    if (!currentAgreement) {
      throw new Error(`No escrow agreement found for job ${jobId}`)
    }

    if (currentAgreement.requiresApproval) {
      if (!currentAgreement.approver) {
        throw new Error(`Escrow agreement requires approval but no approver is set`)
      }
      if (ctx.message.from !== currentAgreement.approver) {
        throw new Error(`Unauthorized: only the designated approver can release milestones`)
      }
    }

    const expectedMilestones = currentAgreement.milestones
    const updatedAgreement = releaseEscrowMilestone(currentAgreement, milestoneId)

    const didUpdate = await updateEscrowAgreementIfUnchanged(updatedAgreement, expectedMilestones)
    if (!didUpdate) {
      const latestAgreement = paymentState.escrowAgreements.get(jobId)
      const latestMilestone = latestAgreement?.milestones.find((m) => m.id === milestoneId)
      if (latestMilestone?.released) {
        throw new Error(`Milestone ${milestoneId} has already been released`)
      }
      throw new Error(`Escrow agreement ${currentAgreement.id} was updated concurrently`)
    }

    paymentState.escrowAgreements.set(jobId, updatedAgreement)

    const shouldSendInvoice = options?.sendInvoice !== false
    const milestone = updatedAgreement.milestones.find((m) => m.id === milestoneId)
    if (shouldSendInvoice && milestone && wallet) {
      const invoice: Invoice = {
        id: crypto.randomUUID(),
        jobId: updatedAgreement.jobId,
        chainId: updatedAgreement.chainId,
        amount: milestone.amount,
        token: updatedAgreement.token,
        recipient: getAddress(wallet),
        validUntil: Date.now() + 3600000,
      }
      const signedInvoice = signingKey ? await signInvoice(signingKey, invoice) : invoice
      await ctx.reply(signedInvoice, 'invoice')
    }
  }

  const sendEscrowInvoice = async (ctx: MessageContext): Promise<void> => {
    const jobId = ctx.message.id
    const agreement = paymentState.escrowAgreements.get(jobId)

    if (!agreement || !wallet) {
      return
    }

    const releasedMilestones = agreement.milestones.filter((m) => m.released)
    if (releasedMilestones.length === 0) {
      return
    }

    const totalAmount = releasedMilestones.reduce((sum, m) => sum + toWei(m.amount), 0n)

    const invoice: Invoice = {
      id: crypto.randomUUID(),
      jobId: agreement.jobId,
      chainId: agreement.chainId,
      amount: bigintToDecimalString(totalAmount),
      token: agreement.token,
      recipient: getAddress(wallet),
      validUntil: Date.now() + 3600000,
    }
    const signedInvoice = signingKey ? await signInvoice(signingKey, invoice) : invoice
    await ctx.reply(signedInvoice, 'invoice')
  }

  const recordTokens = async (
    ctx: MessageContext,
    count: number,
    options?: RecordTokensOptions
  ): Promise<RecordTokensResult> => {
    const channelId = options?.channelId ?? ctx.message.id
    const mutex = getStreamingMutex(paymentState, channelId)
    const release = await mutex.acquire()

    try {
      let agreement = paymentState.streamingAgreements.get(channelId)

      if (!agreement) {
        if (!options?.pricing) {
          throw new Error(`No streaming agreement found for channel ${channelId} and no pricing config provided`)
        }

        if (!wallet) {
          throw new Error('Wallet not configured for payments')
        }

        agreement = {
          id: crypto.randomUUID(),
          jobId: channelId,
          payer: ctx.message.from,
          recipient: getAddress(wallet),
          chainId: options.pricing.chainId,
          token: options.pricing.token ?? 'ETH',
          ratePerToken: bigintToDecimalString(options.pricing.ratePerToken ? toWei(options.pricing.ratePerToken) : 0n),
          accumulatedAmount: '0',
          lastTick: Date.now(),
          status: 'active',
          createdAt: Date.now(),
        }
        await writeStreamingChannel(agreement)
        paymentState.streamingAgreements.set(channelId, agreement)
      }

      const { agreement: updatedAgreement, amountOwed } = recordStreamingTick(agreement, count)

      await updateStreamingChannel(updatedAgreement)
      paymentState.streamingAgreements.set(channelId, updatedAgreement)

      let invoiceSent = false
      if (options?.autoInvoice && parseFloat(amountOwed) > 0) {
        const invoice: Invoice = {
          id: crypto.randomUUID(),
          jobId: channelId,
          chainId: updatedAgreement.chainId,
          amount: amountOwed,
          token: updatedAgreement.token,
          recipient: updatedAgreement.recipient,
          validUntil: Date.now() + 3600000,
        }
        const signedInvoice = signingKey ? await signInvoice(signingKey, invoice) : invoice
        await ctx.reply(signedInvoice, 'invoice')
        invoiceSent = true
      }

      const ratePerToken = parseFloat(updatedAgreement.ratePerToken)
      const totalTokens = ratePerToken > 0
        ? Math.round(parseFloat(updatedAgreement.accumulatedAmount) / ratePerToken)
        : 0

      return {
        channelId,
        tokens: count,
        totalTokens,
        amountOwed,
        totalAmount: updatedAgreement.accumulatedAmount,
        invoiceSent,
      }
    } finally {
      release()
    }
  }

  const sendStreamingInvoice = async (
    ctx: MessageContext,
    channelId: string
  ): Promise<void> => {
    const agreement = paymentState.streamingAgreements.get(channelId)
    if (!agreement) {
      return
    }

    const amount = agreement.accumulatedAmount
    if (parseFloat(amount) <= 0) {
      return
    }

    const invoice: Invoice = {
      id: crypto.randomUUID(),
      jobId: channelId,
      chainId: agreement.chainId,
      amount,
      token: agreement.token,
      recipient: agreement.recipient,
      validUntil: Date.now() + 3600000,
    }
    const signedInvoice = signingKey ? await signInvoice(signingKey, invoice) : invoice
    await ctx.reply({ invoice: signedInvoice }, 'invoice')
  }

  const closeStreamingChannel = async (channelId: string): Promise<void> => {
    const mutex = getStreamingMutex(paymentState, channelId)
    const release = await mutex.acquire()

    try {
      const agreement = paymentState.streamingAgreements.get(channelId)
      if (!agreement) {
        return
      }

      const closedAgreement: StreamingAgreement = {
        ...agreement,
        status: 'closed',
      }

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
      })

      paymentState.streamingAgreements.delete(channelId)
      paymentState.streamingLocks.delete(channelId)
    } finally {
      release()
    }
  }

  const distributeToSwarm = async (
    jobId: string,
    options: DistributeToSwarmOptions
  ): Promise<DistributeToSwarmResult> => {
    const agentId = wallet ? getAddress(wallet) : 'unknown'

    const swarmSplit = createSwarmSplit(
      jobId,
      agentId,
      options.totalAmount,
      options.chainId,
      options.token ?? 'ETH',
      options.participants
    )

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
        metadata: { swarmSplitId: swarmSplit.id },
      }
      await writePaymentLedgerEntry(ledgerEntry)
    }

    const invoicesToAdd = distribution.invoices.length
    const availableSlots = MAX_INVOICE_QUEUE - paymentState.invoiceQueue.length
    if (invoicesToAdd > availableSlots) {
      throw new Error(`Invoice queue limit would be exceeded. Available: ${availableSlots}, needed: ${invoicesToAdd}. Call settleAll() first.`)
    }

    for (const invoice of distribution.invoices) {
      const signedInvoice = signingKey ? await signInvoice(signingKey, invoice) : invoice
      paymentState.invoiceQueue.push(signedInvoice)
    }

    return {
      splitId: swarmSplit.id,
      invoicesSent: distribution.invoices.length,
      totalAmount: options.totalAmount,
    }
  }

  const queueInvoice = (invoice: Invoice): void => {
    if (paymentState.invoiceQueue.length >= MAX_INVOICE_QUEUE) {
      throw new Error(`Invoice queue limit reached (${MAX_INVOICE_QUEUE}). Call settleAll() to process pending invoices.`)
    }
    paymentState.invoiceQueue.push(invoice)
  }

  const settleAll = async (): Promise<BatchSettlementResult[]> => {
    if (!wallet) {
      throw new Error('Wallet not configured for payments')
    }

    if (paymentState.invoiceQueue.length === 0) {
      return []
    }

    const invoices = [...paymentState.invoiceQueue]
    paymentState.invoiceQueue = []

    return batchSettle(wallet, invoices)
  }

  const getPendingInvoices = (): Invoice[] => {
    return [...paymentState.invoiceQueue]
  }

  const rewardPeer = async (
    jobId: string,
    peerAddress: string,
    chainId: number,
    options?: WorkRewardOptions
  ): Promise<WorkRewardResult | null> => {
    if (!wallet) {
      return null
    }

    try {
      const jobIdHash = generateJobId(jobId)
      const difficulty = BigInt(options?.difficulty ?? 1000)
      const consensusAchieved = options?.consensusAchieved ?? false
      const fastResponse = options?.fastResponse ?? false

      const estimated = await estimateReward(
        wallet,
        chainId,
        peerAddress as `0x${string}`,
        difficulty,
        consensusAchieved,
        fastResponse
      )

      const txHash = await distributeReward(
        wallet,
        chainId,
        jobIdHash,
        peerAddress as `0x${string}`,
        difficulty,
        consensusAchieved,
        fastResponse
      )

      return {
        txHash,
        estimatedReward: estimated,
      }
    } catch {
      return null
    }
  }

  return {
    requirePayment,
    createInvoice,
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
    rewardPeer,
  }
}

export function createPaymentState(): PaymentState {
  return {
    escrowAgreements: new Map(),
    streamingAgreements: new Map(),
    streamingLocks: new Map(),
    pendingPayments: new Map(),
    invoiceQueue: [],
  }
}

export async function handlePaymentProof(
  paymentState: PaymentState,
  proof: PaymentProof,
  wallet: WalletState | null
): Promise<boolean> {
  const alreadyProcessed = await isPaymentProofProcessed(proof.txHash, proof.chainId)
  if (alreadyProcessed) {
    return false
  }

  if (!wallet) {
    return false
  }

  const pending = paymentState.pendingPayments.get(proof.invoiceId)
  if (pending) {
    const release = await pending.mutex.acquire()
    try {
      const current = paymentState.pendingPayments.get(proof.invoiceId)
      if (current && !current.settled) {
        let valid = false
        try {
          valid = await verifyPaymentOnChain(wallet, proof, current.invoice)
        } catch (error) {
          current.settled = true
          clearPendingPayment(paymentState, current)
          current.reject(error instanceof Error ? error : new Error(String(error)))
          return false
        }

        if (!valid) {
          current.settled = true
          clearPendingPayment(paymentState, current)
          current.reject(new Error('Payment verification failed: transaction invalid'))
          return false
        }

        await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
        current.settled = true
        clearPendingPayment(paymentState, current)
        current.resolve(proof)
        return true
      }
    } finally {
      release()
    }
  }

  const timedOut = await getTimedOutPayment(proof.invoiceId)
  if (timedOut && timedOut.status === 'pending') {
    let valid = false
    try {
      valid = await verifyPaymentOnChain(wallet, proof, timedOut.invoice)
    } catch {
      return false
    }

    if (!valid) {
      return false
    }

    await processPaymentRecovery(proof.txHash, proof.chainId, proof.invoiceId)
    return true
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
    if (pricing.amount) {
      validateMilestonesTotal(milestones, pricing.amount)
    }
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
  }
  try {
    await writePaymentLedgerEntry(ledgerEntry)
  } catch (error) {
    paymentState.streamingAgreements.delete(jobId)
    throw new Error(`Failed to write payment ledger entry: ${error instanceof Error ? error.message : String(error)}`)
  }

  return agreement
}

export function createFeeHelpers(wallet: WalletState | null): FeeHelpers | null {
  if (!wallet) {
    return null
  }

  const calculateFee = async (chainId: number, amount: bigint): Promise<FeeCalculation> => {
    const feeInfo = await calculateFeeOnChain(wallet, chainId, amount)
    return {
      feePercent: feeInfo.feePercent,
      feeAmount: feeInfo.feeAmount,
      netAmount: amount - feeInfo.feeAmount,
      isEccoDiscount: false,
    }
  }

  const payWithFee = async (
    chainId: number,
    recipient: `0x${string}`,
    amount: bigint
  ): Promise<PayWithFeeResult> => {
    const feeInfo = await calculateFeeOnChain(wallet, chainId, amount)
    const feeHash = await collectFeeOnChain(wallet, chainId, recipient, amount)
    return {
      paymentHash: feeHash,
      feeHash,
      feeAmount: feeInfo.feeAmount,
      netAmount: amount - feeInfo.feeAmount,
    }
  }

  const collectFeeWithEcco = async (
    chainId: number,
    payee: `0x${string}`,
    amount: bigint
  ): Promise<string> => {
    return collectFeeOnChain(wallet, chainId, payee, amount)
  }

  const claimRewards = async (chainId: number): Promise<string> => {
    return claimRewardsOnChain(wallet, chainId)
  }

  const getPendingRewards = async (
    chainId: number
  ): Promise<{ ethPending: bigint; eccoPending: bigint }> => {
    const pending = await getPendingRewardsOnChain(wallet, chainId, wallet.account.address)
    return { ethPending: 0n, eccoPending: pending }
  }

  return {
    calculateFee,
    payWithFee,
    collectFeeWithEcco,
    claimRewards,
    getPendingRewards,
  }
}
