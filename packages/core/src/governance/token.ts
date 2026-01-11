import { getContract, formatEther, parseEther } from 'viem';
import type { WalletState } from '../payments/wallet';
import { getPublicClient, getWalletClient } from '../payments/wallet';
import { ECCO_TOKEN_ABI, getContractAddresses } from '@ecco/contracts';

export interface TokenBalance {
  raw: bigint;
  formatted: string;
}

export interface TokenAllowance {
  raw: bigint;
  formatted: string;
  isApproved: boolean;
}

function getTokenContract(state: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  const publicClient = getPublicClient(state, chainId);

  return getContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    client: publicClient,
  });
}

function getTokenContractWithWallet(state: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  return getContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    client: walletClient,
  });
}

export async function getEccoBalance(state: WalletState, chainId: number, address?: `0x${string}`): Promise<TokenBalance> {
  const contract = getTokenContract(state, chainId);
  const targetAddress = address ?? state.account.address;

  const raw = await contract.read.balanceOf([targetAddress]);

  return {
    raw,
    formatted: formatEther(raw),
  };
}

export async function getEccoAllowance(
  state: WalletState,
  chainId: number,
  spender: `0x${string}`,
  requiredAmount?: bigint
): Promise<TokenAllowance> {
  const contract = getTokenContract(state, chainId);

  const raw = await contract.read.allowance([state.account.address, spender]);

  return {
    raw,
    formatted: formatEther(raw),
    isApproved: requiredAmount ? raw >= requiredAmount : raw > 0n,
  };
}

export async function approveEcco(
  state: WalletState,
  chainId: number,
  spender: `0x${string}`,
  amount: bigint
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    functionName: 'approve',
    args: [spender, amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function transferEcco(
  state: WalletState,
  chainId: number,
  to: `0x${string}`,
  amount: bigint
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    functionName: 'transfer',
    args: [to, amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function burnEcco(
  state: WalletState,
  chainId: number,
  amount: bigint
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    functionName: 'burn',
    args: [amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function delegateVotes(
  state: WalletState,
  chainId: number,
  delegatee: `0x${string}`
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    functionName: 'delegate',
    args: [delegatee],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function getVotingPower(
  state: WalletState,
  chainId: number,
  address?: `0x${string}`
): Promise<TokenBalance> {
  const contract = getTokenContract(state, chainId);
  const targetAddress = address ?? state.account.address;

  const raw = await contract.read.getVotes([targetAddress]);

  return {
    raw,
    formatted: formatEther(raw),
  };
}

export async function getDelegate(
  state: WalletState,
  chainId: number,
  address?: `0x${string}`
): Promise<`0x${string}`> {
  const contract = getTokenContract(state, chainId);
  const targetAddress = address ?? state.account.address;

  return await contract.read.delegates([targetAddress]);
}

export async function getTotalSupply(state: WalletState, chainId: number): Promise<TokenBalance> {
  const contract = getTokenContract(state, chainId);

  const raw = await contract.read.totalSupply();

  return {
    raw,
    formatted: formatEther(raw),
  };
}

export function parseEcco(amount: string): bigint {
  return parseEther(amount);
}

export function formatEcco(amount: bigint): string {
  return formatEther(amount);
}
