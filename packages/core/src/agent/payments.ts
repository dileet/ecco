import type { PrivateKey } from '@libp2p/interface'
import type { Invoice, PaymentProof, EscrowAgreement, StreamingAgreement, SignedInvoice } from '../types'
import type { WalletState } from '../services/wallet'
import { verifyPayment as verifyPaymentOnChain, getAddress, batchSettle } from '../services/wallet'
import type { BatchSettlementResult, WorkRewardOptions, WorkRewardResult, FeeHelpers, FeeCalculation, PayWithFeeResult } from './types'
import { releaseEscrowMilestone, recordStreamingTick } from '../services/payment'
import {
  writeEscrowAgreement,
  updateEscrowAgreement,
  writeStreamingChannel,
  updateStreamingChannel,
  isPaymentProofProcessed,
  markPaymentProofProcessed,
  writeTimedOutPayment,
  getTimedOutPayment,
  markTimedOutPaymentRecovered,
} from '../storage'
import type { MessageContext, PricingConfig, PaymentHelpers, RecordTokensOptions, RecordTokensResult, DistributeToSwarmOptions, DistributeToSwarmResult, ReleaseMilestoneOptions } from './types'
import { createSwarmSplit, distributeSwarmSplit } from '../services/payment'
import { writeSwarmSplit, updateSwarmSplit } from '../storage'
import { distributeReward, estimateReward, generateJobId } from '../services/work-rewards'
import {
  calculateFee as calculateFeeOnChain,
  collectFee as collectFeeOnChain,
  claimRewards as claimRewardsOnChain,
  getPendingRewards as getPendingRewardsOnChain,
} from '../services/fee-collector'
import { signInvoice } from '../utils/invoice-signing'

interface PaymentState {
  escrowAgreements: Map<string, EscrowAgreement>
  streamingAgreements: Map<string, StreamingAgreement>
  pendingPayments: Map<string, {
    invoice: Invoice
    resolve: (proof: PaymentProof) => void
    reject: (error: Error) => void
  }>
  invoiceQueue: Invoice[]
}

function bigintToDecimalString(value: bigint): string {
  const str = value.toString()
  const padded = str.padStart(19, '0')
  const intPart = padded.slice(0, -18) || '0'
  const fracPart = padded.slice(-18).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

function toWei(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value
  const [intPart, fracPart = ''] = value.split('.')
  const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18)
  return BigInt(intPart + paddedFrac)
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

    await ctx.reply({ invoice }, 'invoice')

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(async () => {
        const pending = paymentState.pendingPayments.get(invoice.id)
        if (pending) {
          paymentState.pendingPayments.delete(invoice.id)
          await writeTimedOutPayment(pending.invoice, Date.now())
        }
        reject(new Error('Payment timeout'))
      }, 60000)

      paymentState.pendingPayments.set(invoice.id, {
        invoice,
        resolve: (proof: PaymentProof) => {
          clearTimeout(timeout)
          paymentState.pendingPayments.delete(invoice.id)
          resolve(proof)
        },
        reject: (error: Error) => {
          clearTimeout(timeout)
          paymentState.pendingPayments.delete(invoice.id)
          reject(error)
        },
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
      try {
        const valid = await verifyPaymentOnChain(wallet, proof, pending.invoice)
        if (valid) {
          await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
          paymentState.pendingPayments.delete(proof.invoiceId)
          pending.resolve(proof)
        }
        return valid
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
        paymentState.pendingPayments.delete(proof.invoiceId)
        return false
      }
    }

    const timedOut = await getTimedOutPayment(proof.invoiceId)
    if (timedOut && timedOut.status === 'pending') {
      try {
        const valid = await verifyPaymentOnChain(wallet, proof, timedOut.invoice)
        if (valid) {
          await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
          await markTimedOutPaymentRecovered(proof.invoiceId, proof.txHash)
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
    const agreement = paymentState.escrowAgreements.get(jobId)

    if (!agreement) {
      throw new Error(`No escrow agreement found for job ${jobId}`)
    }

    const updatedAgreement = releaseEscrowMilestone(agreement, milestoneId)
    paymentState.escrowAgreements.set(jobId, updatedAgreement)
    await updateEscrowAgreement(updatedAgreement)

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
      paymentState.streamingAgreements.set(channelId, agreement)
      await writeStreamingChannel(agreement)
    }

    const { agreement: updatedAgreement, amountOwed } = recordStreamingTick(agreement, count)
    paymentState.streamingAgreements.set(channelId, updatedAgreement)
    await updateStreamingChannel(updatedAgreement)

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

    const totalTokens = Math.round(parseFloat(updatedAgreement.accumulatedAmount) / parseFloat(updatedAgreement.ratePerToken))

    return {
      channelId,
      tokens: count,
      totalTokens,
      amountOwed,
      totalAmount: updatedAgreement.accumulatedAmount,
      invoiceSent,
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

    await writeSwarmSplit(swarmSplit)

    const distribution = distributeSwarmSplit(swarmSplit)
    await updateSwarmSplit(distribution.split)

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
    try {
      const valid = await verifyPaymentOnChain(wallet, proof, pending.invoice)
      if (valid) {
        await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
        paymentState.pendingPayments.delete(proof.invoiceId)
        pending.resolve(proof)
        return true
      } else {
        pending.reject(new Error('Payment verification failed: transaction invalid'))
        paymentState.pendingPayments.delete(proof.invoiceId)
        return false
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      paymentState.pendingPayments.delete(proof.invoiceId)
      return false
    }
  }

  const timedOut = await getTimedOutPayment(proof.invoiceId)
  if (timedOut && timedOut.status === 'pending') {
    try {
      const valid = await verifyPaymentOnChain(wallet, proof, timedOut.invoice)
      if (valid) {
        await markPaymentProofProcessed(proof.txHash, proof.chainId, proof.invoiceId)
        await markTimedOutPaymentRecovered(proof.invoiceId, proof.txHash)
        return true
      }
      return false
    } catch {
      return false
    }
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
  const agreement: EscrowAgreement = {
    id: crypto.randomUUID(),
    jobId,
    payer,
    recipient,
    chainId: pricing.chainId,
    token: pricing.token ?? 'ETH',
    totalAmount: bigintToDecimalString(pricing.amount ? toWei(pricing.amount) : 0n),
    milestones: (pricing.milestones ?? []).map((m) => ({
      id: m.id,
      amount: bigintToDecimalString(toWei(m.amount)),
      released: false,
    })),
    status: 'locked',
    createdAt: Date.now(),
    requiresApproval: false,
  }

  paymentState.escrowAgreements.set(jobId, agreement)
  await writeEscrowAgreement(agreement)
  return agreement
}

export async function setupStreamingAgreement(
  paymentState: PaymentState,
  jobId: string,
  payer: string,
  recipient: string,
  pricing: PricingConfig
): Promise<StreamingAgreement> {
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

  paymentState.streamingAgreements.set(jobId, agreement)
  await writeStreamingChannel(agreement)
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
