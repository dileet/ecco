import type { PublicClient, WalletClient } from 'viem';
import { keccak256, toBytes, stringToBytes } from 'viem';
import type { ValidationRegistryState, ValidationRequest, ValidationResponse, ValidationSummary } from './types';

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
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'validationResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getValidationStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'tag', type: 'bytes32' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
  {
    name: 'getValidationRequest',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'requester', type: 'address' },
          { name: 'validator', type: 'address' },
          { name: 'agentId', type: 'uint256' },
          { name: 'requestURI', type: 'string' },
          { name: 'requestHash', type: 'bytes32' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'responded', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getValidationResponse',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'response', type: 'uint8' },
          { name: 'responseURI', type: 'string' },
          { name: 'responseHash', type: 'bytes32' },
          { name: 'tag', type: 'bytes32' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'validatorAddresses', type: 'address[]' },
      { name: 'tag', type: 'bytes32' },
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
    name: 'getPendingRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'validatorAddress', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getValidatorStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'validatorAddress', type: 'address' },
    ],
    outputs: [
      { name: 'responseCount', type: 'uint256' },
      { name: 'averageResponse', type: 'uint8' },
    ],
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

function stringToBytes32(str: string): `0x${string}` {
  if (!str) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  const bytes = stringToBytes(str.slice(0, 32));
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return `0x${Buffer.from(padded).toString('hex')}` as `0x${string}`;
}

export async function requestValidation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ValidationRegistryState,
  validatorAddress: `0x${string}`,
  agentId: bigint,
  requestURI: string,
  requestHash: `0x${string}`
): Promise<{ requestId: `0x${string}`; txHash: `0x${string}` }> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request, result } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'validationRequest',
    args: [validatorAddress, agentId, requestURI, requestHash],
    account,
  });

  const txHash = await walletClient.writeContract(request);

  return { requestId: result, txHash };
}

export async function respondToValidation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ValidationRegistryState,
  requestId: `0x${string}`,
  response: number,
  responseURI: string,
  responseHash: `0x${string}`,
  tag: string
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  if (response < 0 || response > 255) {
    throw new Error('Response must be between 0 and 255');
  }

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'validationResponse',
    args: [requestId, response, responseURI, responseHash, stringToBytes32(tag)],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getValidationStatus(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  requestId: `0x${string}`
): Promise<{
  validatorAddress: `0x${string}`;
  agentId: bigint;
  response: number;
  tag: `0x${string}`;
  lastUpdate: bigint;
}> {
  const [validatorAddress, agentId, response, tag, lastUpdate] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidationStatus',
    args: [requestId],
  });

  return { validatorAddress, agentId, response, tag, lastUpdate };
}

export async function getValidationRequest(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  requestId: `0x${string}`
): Promise<ValidationRequest> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidationRequest',
    args: [requestId],
  });

  return {
    requester: result.requester,
    validator: result.validator,
    agentId: result.agentId,
    requestURI: result.requestURI,
    requestHash: result.requestHash,
    timestamp: result.timestamp,
    responded: result.responded,
  };
}

export async function getValidationResponse(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  requestId: `0x${string}`
): Promise<ValidationResponse> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidationResponse',
    args: [requestId],
  });

  return {
    response: result.response,
    responseURI: result.responseURI,
    responseHash: result.responseHash,
    tag: result.tag,
    timestamp: result.timestamp,
  };
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
    args: [agentId, validatorAddresses, stringToBytes32(tag)],
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

export async function getPendingRequests(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  validatorAddress: `0x${string}`
): Promise<`0x${string}`[]> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getPendingRequests',
    args: [validatorAddress],
  });
  return [...result];
}

export async function getValidatorStats(
  publicClient: PublicClient,
  state: ValidationRegistryState,
  agentId: bigint,
  validatorAddress: `0x${string}`
): Promise<{ responseCount: bigint; averageResponse: number }> {
  const [responseCount, averageResponse] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_VALIDATION_REGISTRY_ABI,
    functionName: 'getValidatorStats',
    args: [agentId, validatorAddress],
  });

  return { responseCount, averageResponse };
}
