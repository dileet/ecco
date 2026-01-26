import type { PublicClient, WalletClient } from 'viem';
import type { ValidationRegistryState, ValidationSummary } from './types';

const AGENT_VALIDATION_REGISTRY_ABI = [
  {
    name: 'validationRequest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'validationResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getValidationStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestHash', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'validatorAddresses', type: 'address[]' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'averageResponse', type: 'uint8' },
    ],
  },
  {
    name: 'getAgentValidations',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getValidatorRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'validatorAddress', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getIdentityRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export function createValidationRegistryState(
  chainId: number,
  registryAddress: `0x${string}`,
  identityRegistryAddress: `0x${string}`
): ValidationRegistryState {
  return {
    chainId,
    registryAddress,
    identityRegistryAddress,
  };
}

export async function requestValidation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ValidationRegistryState,
  validatorAddress: `0x${string}`,
  agentId: bigint,
  requestURI: string,
  requestHash: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'validationRequest',
    args: [validatorAddress, agentId, requestURI, requestHash],
    account,
  });

  return walletClient.writeContract(request);
}

export async function respondToValidation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ValidationRegistryState,
  requestHash: `0x${string}`,
  response: number,
  responseURI: string,
  responseHash: `0x${string}`,
  tag: string
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  if (response < 0 || response > 100) {
    throw new Error('Response must be between 0 and 100');
  }

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'validationResponse',
    args: [requestHash, response, responseURI, responseHash, tag],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getValidationStatus(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  requestHash: `0x${string}`
): Promise<{
  validatorAddress: `0x${string}`;
  agentId: bigint;
  response: number;
  responseHash: `0x${string}`;
  tag: string;
  lastUpdate: bigint;
}> {
  const [validatorAddress, agentId, response, responseHash, tag, lastUpdate] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidationStatus',
    args: [requestHash],
  });

  return { validatorAddress, agentId, response, responseHash, tag, lastUpdate };
}

export async function getValidationSummary(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  agentId: bigint,
  validatorAddresses: `0x${string}`[] = [],
  tag: string = ''
): Promise<ValidationSummary> {
  const [count, averageResponse] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getSummary',
    args: [agentId, validatorAddresses, tag],
  });

  return {
    count: Number(count),
    averageResponse,
  };
}

export async function getAgentValidations(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  agentId: bigint
): Promise<`0x${string}`[]> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getAgentValidations',
    args: [agentId],
  });
  return [...result];
}

export async function getValidatorRequests(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  validatorAddress: `0x${string}`
): Promise<`0x${string}`[]> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidatorRequests',
    args: [validatorAddress],
  });
  return [...result];
}

export async function getValidationIdentityRegistry(
  publicClient: PublicClient,
  state: ValidationRegistryState
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getIdentityRegistry',
  });
}
