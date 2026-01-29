import type { PrivateKey } from '@libp2p/interface'
import { generatePrivateKey } from 'viem/accounts'
import { createWalletState, type WalletState } from '../payments/wallet'
import {
  createDefaultPeerResolver,
  createReputationState,
  loadReputationFromStorage,
  resolveRegistryAddresses,
  type FeedbackConfig,
  type ReputationState,
  type PeerResolver,
} from '../reputation/reputation-state'
import { createPaymentHelpers, createPaymentState, type PaymentState } from '../payments/payment-helpers'
import type { PaymentHelpers } from './types'

export interface WalletSetupConfig {
  ethereumPrivateKey: `0x${string}` | undefined
  walletEnabled?: boolean
  rpcUrls: Record<number, string>
  chainId: number
  libp2pPrivateKey: PrivateKey
  reputation?: {
    commitThreshold?: number
    syncIntervalMs?: number
    peerResolver?: PeerResolver
    identityRegistryAddress?: `0x${string}`
    reputationRegistryAddress?: `0x${string}`
    feedback?: FeedbackConfig
  }
}

export interface WalletSetupResult {
  walletState: WalletState | null
  reputationState: ReputationState | null
  paymentState: PaymentState
  payments: PaymentHelpers
}

export async function setupWallet(config: WalletSetupConfig): Promise<WalletSetupResult> {
  const ethereumPrivateKey = config.ethereumPrivateKey
    ?? (config.walletEnabled ? generatePrivateKey() : undefined)

  let walletState: WalletState | null = null
  if (ethereumPrivateKey) {
    walletState = createWalletState({
      privateKey: ethereumPrivateKey,
      rpcUrls: config.rpcUrls,
    })
  }

  let reputationState: ReputationState | null = null
  if (walletState) {
    const addresses = resolveRegistryAddresses(config.chainId, {
      identityRegistryAddress: config.reputation?.identityRegistryAddress,
      reputationRegistryAddress: config.reputation?.reputationRegistryAddress,
    })
    const peerResolver = config.reputation?.peerResolver ?? createDefaultPeerResolver({
      chainId: config.chainId,
      wallet: walletState,
      identityRegistryAddress: addresses.identityRegistryAddress,
    })
    reputationState = createReputationState({
      chainId: config.chainId,
      commitThreshold: config.reputation?.commitThreshold,
      syncIntervalMs: config.reputation?.syncIntervalMs,
      peerResolver,
      identityRegistryAddress: addresses.identityRegistryAddress,
      reputationRegistryAddress: addresses.reputationRegistryAddress,
      feedback: config.reputation?.feedback,
    })
    await loadReputationFromStorage(reputationState)
  }

  const paymentState = createPaymentState()
  const payments = createPaymentHelpers(walletState, paymentState, config.libp2pPrivateKey)

  return {
    walletState,
    reputationState,
    paymentState,
    payments,
  }
}
