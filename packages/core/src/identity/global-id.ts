import type { GlobalAgentId } from './types';

const GLOBAL_ID_REGEX = /^eip155:(\d+):(0x[a-fA-F0-9]{40})$/;

const KNOWN_REGISTRIES: Record<number, `0x${string}`> = {
  143: '0x0000000000000000000000000000000000000000',
  10143: '0x0000000000000000000000000000000000000000',
};

export function formatGlobalId(
  chainId: number,
  registryAddress: `0x${string}`
): string {
  return `eip155:${chainId}:${registryAddress.toLowerCase()}`;
}

export function parseGlobalId(globalId: string): GlobalAgentId {
  const match = globalId.match(GLOBAL_ID_REGEX);
  if (!match) {
    throw new Error(`Invalid global ID format: ${globalId}`);
  }

  const [, chainIdStr, registryAddress] = match;
  return {
    namespace: 'eip155',
    chainId: parseInt(chainIdStr, 10),
    registryAddress: registryAddress.toLowerCase() as `0x${string}`,
  };
}

export function validateGlobalId(globalId: string): boolean {
  return GLOBAL_ID_REGEX.test(globalId);
}

export function getRegistryForChain(chainId: number): `0x${string}` | null {
  return KNOWN_REGISTRIES[chainId] ?? null;
}

export function setRegistryForChain(chainId: number, address: `0x${string}`): void {
  KNOWN_REGISTRIES[chainId] = address;
}

export function getSupportedChainIds(): number[] {
  return Object.keys(KNOWN_REGISTRIES).map(Number);
}

export function isChainSupported(chainId: number): boolean {
  return chainId in KNOWN_REGISTRIES;
}

export function extractChainId(globalId: string): number {
  const parsed = parseGlobalId(globalId);
  return parsed.chainId;
}

export function extractRegistryAddress(globalId: string): `0x${string}` {
  const parsed = parseGlobalId(globalId);
  return parsed.registryAddress;
}

export function isSameChain(globalId1: string, globalId2: string): boolean {
  return extractChainId(globalId1) === extractChainId(globalId2);
}

export function isSameRegistry(globalId1: string, globalId2: string): boolean {
  const parsed1 = parseGlobalId(globalId1);
  const parsed2 = parseGlobalId(globalId2);
  return (
    parsed1.chainId === parsed2.chainId &&
    parsed1.registryAddress === parsed2.registryAddress
  );
}
