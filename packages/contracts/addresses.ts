const SEPOLIA_CHAIN_ID = 11155111;

export const ERC8004_ADDRESSES: Record<number, {
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry: `0x${string}`;
}> = {
  [SEPOLIA_CHAIN_ID]: {
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validationRegistry: '0x0000000000000000000000000000000000000000',
  },
};

export function getERC8004Addresses(chainId: number) {
  return ERC8004_ADDRESSES[chainId];
}

export function hasOfficialERC8004(chainId: number): boolean {
  const addresses = ERC8004_ADDRESSES[chainId];
  return addresses !== undefined && addresses.identityRegistry !== '0x0000000000000000000000000000000000000000';
}

export const CONTRACT_ADDRESSES = {
  [SEPOLIA_CHAIN_ID]: {
    eccoToken: '0x0000000000000000000000000000000000000000' as const,
    agentIdentityRegistry: ERC8004_ADDRESSES[SEPOLIA_CHAIN_ID].identityRegistry,
    agentReputationRegistry: ERC8004_ADDRESSES[SEPOLIA_CHAIN_ID].reputationRegistry,
    agentValidationRegistry: ERC8004_ADDRESSES[SEPOLIA_CHAIN_ID].validationRegistry,
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
