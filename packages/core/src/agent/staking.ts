import type { WalletState } from '../services/wallet'
import { getAddress } from '../services/wallet'
import type { ReputationState } from '../node/reputation'
import {
  stake as stakeContract,
  requestUnstake as requestUnstakeContract,
  getStakeInfo as getStakeInfoContract,
} from '../services/reputation-contract'
import { resolveWalletForPeer as resolveWalletForPeerImpl } from '../node'

export interface StakingMethodsConfig {
  walletState: WalletState | null
  reputationState: ReputationState | null
  chainId: number
}

export function createStakingMethods(config: StakingMethodsConfig) {
  const { walletState, reputationState, chainId } = config

  const stake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for staking. Configure wallet in createAgent options.')
    }
    return stakeContract(walletState, chainId, amount)
  }

  const unstake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for unstaking. Configure wallet in createAgent options.')
    }
    return requestUnstakeContract(walletState, chainId, amount)
  }

  const getStakeInfo = async () => {
    const walletAddress = walletState ? getAddress(walletState) : null
    if (!walletState || !walletAddress) {
      throw new Error('Wallet required to get stake info. Configure wallet in createAgent options.')
    }
    return getStakeInfoContract(walletState, chainId, walletAddress)
  }

  const resolveWalletForPeer = async (peerId: string): Promise<`0x${string}` | null> => {
    if (!walletState || !reputationState) {
      throw new Error('Wallet required to resolve peer wallets. Configure wallet in createAgent options.')
    }
    return resolveWalletForPeerImpl(reputationState, walletState, peerId)
  }

  return {
    stake,
    unstake,
    getStakeInfo,
    resolveWalletForPeer,
  }
}
