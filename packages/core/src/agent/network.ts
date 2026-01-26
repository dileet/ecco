import { z } from 'zod'
import {
  ECCO_TESTNET,
  ECCO_MAINNET,
  type NetworkConfig,
  type NetworkName,
  getDefaultChainId,
  DEFAULT_RPC_URLS,
} from '../networks'
import type { AgentConfig } from './types'

const RpcUrlSchema = z.string().url()

export function resolveNetworkConfig(network: AgentConfig['network']): NetworkConfig {
  if (network === 'mainnet') return ECCO_MAINNET
  return ECCO_TESTNET
}

export function resolveBootstrapAddrs(network: AgentConfig['network'], bootstrap?: string[]): string[] {
  if (bootstrap && bootstrap.length > 0) return bootstrap
  if (network === 'mainnet') return ECCO_MAINNET.bootstrap.peers
  return ECCO_TESTNET.bootstrap.peers
}

export function resolveNetworkName(network: AgentConfig['network']): NetworkName {
  if (network === 'mainnet') return 'mainnet'
  return 'testnet'
}

export function resolveChainId(network: AgentConfig['network'], reputationConfig?: { chainId?: number }): number {
  if (reputationConfig?.chainId) return reputationConfig.chainId
  const networkName = resolveNetworkName(network)
  return getDefaultChainId(networkName)
}

function validateRpcUrls(urls: Record<number, string>): void {
  for (const [chainId, url] of Object.entries(urls)) {
    const result = RpcUrlSchema.safeParse(url)
    if (!result.success) {
      throw new Error(`Invalid RPC URL for chain ${chainId}: ${url}`)
    }
  }
}

export function mergeRpcUrls(userRpcUrls: Record<number, string> | undefined): Record<number, string> {
  const defaultUrls = { ...DEFAULT_RPC_URLS }
  if (userRpcUrls) {
    validateRpcUrls(userRpcUrls)
    return { ...defaultUrls, ...userRpcUrls }
  }
  return defaultUrls
}
