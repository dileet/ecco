import type { WalletState } from '../payments/wallet'
import { getPublicClient, getWalletClient } from '../payments/wallet'
import type { ReputationState } from './reputation-state'
import {
  createStakeRegistryState,
  stakeForAgent,
  requestUnstake,
  fetchStakeInfo,
} from '../identity'
import type { StakeInfo, StakeRegistryState } from '../identity'
import { resolveWalletForPeer as resolveWalletForPeerImpl } from '../networking'

const STAKE_REGISTRY_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000'
const IDENTITY_REGISTRY_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000'

export interface StakingMethodsConfig {
  walletState: WalletState | null
  reputationState: ReputationState | null
  chainId: number
  getAgentId: () => bigint | null
}

export function createStakingMethods(config: StakingMethodsConfig) {
  const { walletState, reputationState, chainId, getAgentId } = config

  const getStakeState = (): StakeRegistryState => {
    return createStakeRegistryState(chainId, STAKE_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ADDRESS)
  }

  const stake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for staking. Configure wallet in createAgent options.')
    }
    const agentId = getAgentId()
    if (agentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before staking.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const state = getStakeState()

    return stakeForAgent(publicClient, walletClient, state, agentId, amount)
  }

  const unstake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for unstaking. Configure wallet in createAgent options.')
    }
    const agentId = getAgentId()
    if (agentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before unstaking.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const state = getStakeState()

    return requestUnstake(publicClient, walletClient, state, agentId, amount)
  }

  const getStakeInfo = async (): Promise<StakeInfo> => {
    if (!walletState) {
      throw new Error('Wallet required to get stake info. Configure wallet in createAgent options.')
    }
    const agentId = getAgentId()
    if (agentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before getting stake info.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const state = getStakeState()

    return fetchStakeInfo(publicClient, state, agentId)
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
