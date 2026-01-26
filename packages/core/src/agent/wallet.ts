import type { PrivateKey } from '@libp2p/interface'
import { createWalletState, type WalletState } from '../payments/wallet'
import {
  createDefaultPeerResolver,
  createReputationState,
  resolveRegistryAddresses,
  type ReputationState,
  type PeerResolver,
} from '../reputation/reputation-state'
import { createPaymentHelpers, createPaymentState, createFeeHelpers, type PaymentState } from '../payments/payment-helpers'
import type { PaymentHelpers, FeeHelpers } from './types'

export interface WalletSetupConfig {
  ethereumPrivateKey: `0x${string}` | undefined
  rpcUrls: Record<number, string>
  chainId: number
  libp2pPrivateKey: PrivateKey
  reputation?: {
    commitThreshold?: number
    syncIntervalMs?: number
    peerResolver?: PeerResolver
    identityRegistryAddress?: `0x${string}`
    reputationRegistryAddress?: `0x${string}`
  }
}

export interface WalletSetupResult {
  walletState: WalletState | null
  reputationState: ReputationState | null
  paymentState: PaymentState
  payments: PaymentHelpers
  fees: FeeHelpers | null
}

export function setupWallet(config: WalletSetupConfig): WalletSetupResult {
  let walletState: WalletState | null = null
  if (config.ethereumPrivateKey) {
    walletState = createWalletState({
      privateKey: config.ethereumPrivateKey,
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
    })
  }

  const paymentState = createPaymentState()
  const payments = createPaymentHelpers(walletState, paymentState, config.libp2pPrivateKey)
  const fees = createFeeHelpers(walletState)

  return {
    walletState,
    reputationState,
    paymentState,
    payments,
    fees,
  }
}
