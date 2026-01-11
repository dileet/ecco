import { getContract } from 'viem';
import { type WalletState, getPublicClient, getWalletClient } from './wallet';
import { FEE_COLLECTOR_ABI, getContractAddresses } from '@ecco/contracts';
import { approveEcco, getEccoAllowance } from '../governance/token';

export interface FeeInfo {
  feePercent: number;
  feeAmount: bigint;
}

export interface FeeStats {
  totalCollected: bigint;
  totalBurned: bigint;
  feePercent: number;
  stakerShare: number;
  treasuryShare: number;
  burnShare: number;
}

function getFeeCollectorContract(wallet: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  return getContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    client: getPublicClient(wallet, chainId),
  });
}

export async function calculateFee(
  wallet: WalletState,
  chainId: number,
  amount: bigint
): Promise<FeeInfo> {
  const contract = getFeeCollectorContract(wallet, chainId);
  const feeAmount = await contract.read.calculateFee([amount]);
  const feePercent = await contract.read.feePercent();

  return {
    feePercent: Number(feePercent),
    feeAmount,
  };
}

export async function collectFee(
  wallet: WalletState,
  chainId: number,
  payee: `0x${string}`,
  amount: bigint
): Promise<string> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(wallet, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const feeInfo = await calculateFee(wallet, chainId, amount);

  const allowance = await getEccoAllowance(wallet, chainId, addresses.feeCollector, feeInfo.feeAmount);
  if (!allowance.isApproved) {
    await approveEcco(wallet, chainId, addresses.feeCollector, feeInfo.feeAmount);
  }

  const hash = await walletClient.writeContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'collectFee',
    args: [walletClient.account.address, payee, amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function getPendingRewards(
  wallet: WalletState,
  chainId: number,
  staker: `0x${string}`
): Promise<bigint> {
  const contract = getFeeCollectorContract(wallet, chainId);
  return await contract.read.pendingRewards([staker]);
}

export async function claimRewards(
  wallet: WalletState,
  chainId: number
): Promise<string> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(wallet, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'claimRewards',
    args: [],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function distributeFees(
  wallet: WalletState,
  chainId: number
): Promise<string> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(wallet, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'distributeFees',
    args: [],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function getFeeStats(
  wallet: WalletState,
  chainId: number
): Promise<FeeStats> {
  const contract = getFeeCollectorContract(wallet, chainId);

  const [
    totalCollected,
    totalBurned,
    feePercent,
    stakerShare,
    treasuryShare,
    burnShare,
  ] = await Promise.all([
    contract.read.totalCollected(),
    contract.read.totalBurned(),
    contract.read.feePercent(),
    contract.read.stakerShare(),
    contract.read.treasuryShare(),
    contract.read.burnShare(),
  ]);

  return {
    totalCollected,
    totalBurned,
    feePercent: Number(feePercent),
    stakerShare: Number(stakerShare),
    treasuryShare: Number(treasuryShare),
    burnShare: Number(burnShare),
  };
}
