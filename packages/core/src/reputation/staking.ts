import type { WalletState } from '../payments/wallet'
import { getAddress, getPublicClient, getWalletClient } from '../payments/wallet'
import type { ReputationState } from './reputation-state'
import {
  createIdentityRegistryState,
  stakeForAgent,
  requestUnstake as requestUnstakeIdentity,
  getStakeInfo as getStakeInfoIdentity,
  getStakeInfoByWallet,
  getAgentByPeerId,
} from '../identity'
import type { StakeInfo, IdentityRegistryState } from '../identity'
import { resolveWalletForPeer as resolveWalletForPeerImpl } from '../networking'
import { MONAD_TESTNET_CHAIN_ID } from '../networks'

const IDENTITY_REGISTRY_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000'

export interface StakingMethodsConfig {
  walletState: WalletState | null
  reputationState: ReputationState | null
  chainId: number
  agentId?: bigint
}

export function createStakingMethods(config: StakingMethodsConfig) {
  const { walletState, reputationState, chainId, agentId } = config

  const getIdentityState = (): IdentityRegistryState => {
    return createIdentityRegistryState(chainId, IDENTITY_REGISTRY_ADDRESS)
  }

  const stake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for staking. Configure wallet in createAgent options.')
    }
    if (agentId === undefined) {
      throw new Error('Agent ID required for staking. Register agent on-chain first.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const state = getIdentityState()

    return stakeForAgent(publicClient, walletClient, state, agentId, amount)
  }

  const unstake = async (amount: bigint): Promise<string> => {
    if (!walletState) {
      throw new Error('Wallet required for unstaking. Configure wallet in createAgent options.')
    }
    if (agentId === undefined) {
      throw new Error('Agent ID required for unstaking. Register agent on-chain first.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const state = getIdentityState()

    return requestUnstakeIdentity(publicClient, walletClient, state, agentId, amount)
  }

  const getStakeInfo = async (): Promise<StakeInfo> => {
    const walletAddress = walletState ? getAddress(walletState) : null
    if (!walletState || !walletAddress) {
      throw new Error('Wallet required to get stake info. Configure wallet in createAgent options.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const state = getIdentityState()

    if (agentId !== undefined) {
      return getStakeInfoIdentity(publicClient, state, agentId)
    }

    return getStakeInfoByWallet(publicClient, state, walletAddress)
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
