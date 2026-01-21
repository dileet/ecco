const MAINNET_CHAIN_ID = 143;
const TESTNET_CHAIN_ID = 10143;

export const CONTRACT_ADDRESSES = {
  [TESTNET_CHAIN_ID]: {
    eccoToken: '0x0000000000000000000000000000000000000000' as const,
    agentIdentityRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentReputationRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentValidationRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentStakeRegistry: '0x0000000000000000000000000000000000000000' as const,
    feeCollector: '0x0000000000000000000000000000000000000000' as const,
    workRewards: '0x0000000000000000000000000000000000000000' as const,
    eccoGovernor: '0x0000000000000000000000000000000000000000' as const,
    eccoTimelock: '0x0000000000000000000000000000000000000000' as const,
    eccoConstitution: '0x0000000000000000000000000000000000000000' as const,
  },
  [MAINNET_CHAIN_ID]: {
    eccoToken: '0x0000000000000000000000000000000000000000' as const,
    agentIdentityRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentReputationRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentValidationRegistry: '0x0000000000000000000000000000000000000000' as const,
    agentStakeRegistry: '0x0000000000000000000000000000000000000000' as const,
    feeCollector: '0x0000000000000000000000000000000000000000' as const,
    workRewards: '0x0000000000000000000000000000000000000000' as const,
    eccoGovernor: '0x0000000000000000000000000000000000000000' as const,
    eccoTimelock: '0x0000000000000000000000000000000000000000' as const,
    eccoConstitution: '0x0000000000000000000000000000000000000000' as const,
  },
} as const;

export type SupportedChainId = keyof typeof CONTRACT_ADDRESSES;

export function getContractAddresses(chainId: number) {
  const addresses = CONTRACT_ADDRESSES[chainId as SupportedChainId];
  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported for contracts`);
  }
  return addresses;
}
