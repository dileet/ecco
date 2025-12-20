import { createPublicClient, http, getContract } from 'viem';
import { ECCO_CONSTITUTION_ABI, getContractAddresses } from '@ecco/contracts';
import type { Constitution } from '../types';
import { getDefaultRpcUrl } from '../networks';

interface ConstitutionCache {
  constitution: Constitution;
  timestamp: number;
}

const cache = new Map<number, ConstitutionCache>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchOnChainConstitution(
  chainId: number,
  rpcUrl?: string
): Promise<Constitution> {
  const cached = cache.get(chainId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.constitution;
  }

  const url = rpcUrl ?? getDefaultRpcUrl(chainId);
  if (!url) {
    throw new Error(`No RPC URL available for chain ${chainId}`);
  }

  const addresses = getContractAddresses(chainId);

  const client = createPublicClient({
    transport: http(url),
  });

  const contract = getContract({
    address: addresses.eccoConstitution,
    abi: ECCO_CONSTITUTION_ABI,
    client,
  });

  const items = await contract.read.getAllItems() as string[];

  const constitution: Constitution = {
    rules: items,
  };

  cache.set(chainId, {
    constitution,
    timestamp: Date.now(),
  });

  return constitution;
}

export function clearConstitutionCache(chainId?: number): void {
  if (chainId !== undefined) {
    cache.delete(chainId);
  } else {
    cache.clear();
  }
}

export function getConstitutionCacheAge(chainId: number): number | null {
  const cached = cache.get(chainId);
  if (!cached) {
    return null;
  }
  return Date.now() - cached.timestamp;
}
