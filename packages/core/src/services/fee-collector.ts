import { getContract } from 'viem';
import { type WalletState, getPublicClient, getWalletClient } from './wallet';
import { FEE_COLLECTOR_ABI, getContractAddresses } from '@ecco/contracts';

export interface FeeInfo {
  feePercent: number;
  feeAmount: bigint;
  isEccoDiscount: boolean;
}

export interface PendingRewards {
  ethPending: bigint;
  eccoPending: bigint;
}

export interface FeeStats {
  totalEthCollected: bigint;
  totalEccoCollected: bigint;
  totalEccoBurned: bigint;
  ethFeePercent: number;
  eccoFeePercent: number;
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
  payer: `0x${string}`,
  amount: bigint
): Promise<FeeInfo> {
  const contract = getFeeCollectorContract(wallet, chainId);

  const [feePercent, feeAmount, isEccoDiscount] = await contract.read.calculateFee([
    payer,
    amount,
  ]) as [bigint, bigint, boolean];

  return {
    feePercent: Number(feePercent),
    feeAmount,
    isEccoDiscount,
  };
}

export async function collectFeeWithEth(
  wallet: WalletState,
  chainId: number,
  payee: `0x${string}`,
  amount: bigint,
  fee: bigint
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'collectFee',
    args: [wallet.account.address, payee, amount],
    value: fee,
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function collectFeeWithEcco(
  wallet: WalletState,
  chainId: number,
  payee: `0x${string}`,
  amount: bigint
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'collectFeeInEcco',
    args: [wallet.account.address, payee, amount],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function getPendingRewards(
  wallet: WalletState,
  chainId: number,
  staker: `0x${string}`
): Promise<PendingRewards> {
  const contract = getFeeCollectorContract(wallet, chainId);

  const [ethPending, eccoPending] = await contract.read.pendingRewards([staker]) as [bigint, bigint];

  return {
    ethPending,
    eccoPending,
  };
}

export async function claimRewards(
  wallet: WalletState,
  chainId: number
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'claimRewards',
    args: [],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function distributeFees(
  wallet: WalletState,
  chainId: number
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'distributeFees',
    args: [],
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
    totalEthCollected,
    totalEccoCollected,
    totalEccoBurned,
    ethFeePercent,
    eccoFeePercent,
    stakerShare,
    treasuryShare,
    burnShare,
  ] = await Promise.all([
    contract.read.totalEthCollected() as Promise<bigint>,
    contract.read.totalEccoCollected() as Promise<bigint>,
    contract.read.totalEccoBurned() as Promise<bigint>,
    contract.read.ethFeePercent() as Promise<bigint>,
    contract.read.eccoFeePercent() as Promise<bigint>,
    contract.read.stakerShare() as Promise<bigint>,
    contract.read.treasuryShare() as Promise<bigint>,
    contract.read.burnShare() as Promise<bigint>,
  ]);

  return {
    totalEthCollected,
    totalEccoCollected,
    totalEccoBurned,
    ethFeePercent: Number(ethFeePercent),
    eccoFeePercent: Number(eccoFeePercent),
    stakerShare: Number(stakerShare),
    treasuryShare: Number(treasuryShare),
    burnShare: Number(burnShare),
  };
}

export async function payWithFee(
  wallet: WalletState,
  chainId: number,
  recipient: `0x${string}`,
  amount: bigint
): Promise<{ paymentHash: string; feeHash: string; feeAmount: bigint; netAmount: bigint }> {
  const feeInfo = await calculateFee(wallet, chainId, wallet.account.address, amount);

  const feeHash = await collectFeeWithEth(wallet, chainId, recipient, amount, feeInfo.feeAmount);

  const netAmount = amount - feeInfo.feeAmount;

  const paymentHash = await getWalletClient(wallet, chainId).sendTransaction({
    chain: undefined,
    account: wallet.account,
    to: recipient,
    value: netAmount,
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash: paymentHash });

  return {
    paymentHash,
    feeHash,
    feeAmount: feeInfo.feeAmount,
    netAmount,
  };
}
