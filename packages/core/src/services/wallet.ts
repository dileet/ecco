import { createPublicClient, createWalletClient, defineChain, http, type PublicClient, type WalletClient, type Chain, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEther } from 'viem';
import { z } from 'zod';
import type { Invoice, PaymentProof } from '../types';
import { aggregateInvoices, type AggregatedInvoice } from './payment';
import { isValidUrl } from '../utils';

const ChainIdSchema = z.number().int().positive();
const EthAddressSchema = z.string().refine(isAddress, { message: 'Invalid Ethereum address' });
const RpcUrlSchema = z.string().url().optional();

function validateChainId(chainId: number, context: string): void {
  const result = ChainIdSchema.safeParse(chainId);
  if (!result.success) {
    throw new Error(`Invalid chain ID in ${context}: ${chainId}`);
  }
}

function validateAddress(address: string, context: string): asserts address is `0x${string}` {
  const result = EthAddressSchema.safeParse(address);
  if (!result.success) {
    throw new Error(`Invalid address format in ${context}: ${address}`);
  }
}

function validateRpcUrl(url: string | undefined, chainId: number): void {
  if (url === undefined) return;
  const result = RpcUrlSchema.safeParse(url);
  if (!result.success && !isValidUrl(url)) {
    throw new Error(`Invalid RPC URL for chain ${chainId}: ${url}`);
  }
}

const MAX_ETH_AMOUNT = 1e15;

function validateAmount(amount: string, context: string): void {
  const trimmed = amount.trim();
  if (!trimmed || isNaN(Number(trimmed))) {
    throw new Error(`Invalid amount format in ${context}: "${amount}"`);
  }
  const numericAmount = Number(trimmed);
  if (numericAmount < 0) {
    throw new Error(`Amount cannot be negative in ${context}: ${amount}`);
  }
  if (numericAmount > MAX_ETH_AMOUNT) {
    throw new Error(`Amount exceeds maximum allowed (${MAX_ETH_AMOUNT} ETH) in ${context}: ${amount}`);
  }
}

interface NonceState {
  currentNonce: number;
  pendingCount: number;
  lastSyncBlock: bigint;
  mutex: Promise<void>;
  resolveMutex: (() => void) | null;
}

interface NonceManager {
  nonceStates: Map<number, NonceState>;
}

function createNonceManager(): NonceManager {
  return { nonceStates: new Map() };
}

async function syncNonceFromChain(
  publicClient: PublicClient,
  address: `0x${string}`,
  chainId: number,
  manager: NonceManager
): Promise<NonceState> {
  const [pendingNonce, blockNumber] = await Promise.all([
    publicClient.getTransactionCount({ address, blockTag: 'pending' }),
    publicClient.getBlockNumber()
  ]);
  
  const state: NonceState = {
    currentNonce: pendingNonce,
    pendingCount: 0,
    lastSyncBlock: blockNumber,
    mutex: Promise.resolve(),
    resolveMutex: null
  };
  
  manager.nonceStates.set(chainId, state);
  return state;
}

async function acquireNonce(
  publicClient: PublicClient,
  address: `0x${string}`,
  chainId: number,
  manager: NonceManager
): Promise<{ nonce: number; release: (success: boolean) => void }> {
  let state = manager.nonceStates.get(chainId);
  
  if (!state) {
    state = await syncNonceFromChain(publicClient, address, chainId, manager);
  }
  
  await state.mutex;
  
  let resolveNext: (() => void) | null = null;
  state.mutex = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  state.resolveMutex = resolveNext;
  
  const currentBlock = await publicClient.getBlockNumber();
  const RESYNC_THRESHOLD = 10n;
  
  if (currentBlock - state.lastSyncBlock > RESYNC_THRESHOLD) {
    const freshNonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
    if (freshNonce > state.currentNonce) {
      state.currentNonce = freshNonce;
      state.pendingCount = 0;
    }
    state.lastSyncBlock = currentBlock;
  }
  
  const nonce = state.currentNonce + state.pendingCount;
  state.pendingCount++;
  
  const release = (success: boolean) => {
    if (success) {
      state!.currentNonce++;
    }
    state!.pendingCount--;
    
    if (state!.pendingCount < 0) {
      state!.pendingCount = 0;
    }
    
    if (state!.resolveMutex) {
      state!.resolveMutex();
      state!.resolveMutex = null;
    }
  };
  
  return { nonce, release };
}

const monadMainnet = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Monadscan', url: 'https://monadscan.com' },
  },
})

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Testnet MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Monad Testnet Explorer', url: 'https://testnet.monadexplorer.com' },
  },
  testnet: true,
})

const DEFAULT_CHAINS = [monadMainnet, monadTestnet];

export interface WalletConfig {
  privateKey: `0x${string}`;
  chains?: Chain[];
  rpcUrls?: Record<number, string>;
}

export interface WalletState {
  config: WalletConfig;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClients: Map<number, PublicClient>;
  walletClients: Map<number, WalletClient>;
  nonceManager: NonceManager;
}

function getChainById(chainId: number, chains: Chain[]): Chain {
  const chain = chains.find((c) => c.id === chainId);
  if (chain) return chain;
  if (chainId === monadMainnet.id) return monadMainnet;
  if (chainId === monadTestnet.id) return monadTestnet;
  throw new Error(`Chain ${chainId} not found`);
}

export function createWalletState(config: WalletConfig): WalletState {
  const account = privateKeyToAccount(config.privateKey);
  const chains = config.chains ?? DEFAULT_CHAINS;
  const publicClients = new Map<number, PublicClient>();
  const walletClients = new Map<number, WalletClient>();
  const nonceManager = createNonceManager();

  for (const chain of chains) {
    validateChainId(chain.id, 'chain config');
    const rpcUrl = config.rpcUrls?.[chain.id];
    validateRpcUrl(rpcUrl, chain.id);
    publicClients.set(chain.id, createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient);
    walletClients.set(chain.id, createWalletClient({ chain, account, transport: http(rpcUrl) }) as WalletClient);
  }

  return { config, account, publicClients, walletClients, nonceManager };
}

export function getPublicClient(state: WalletState, chainId: number): PublicClient {
  const existing = state.publicClients.get(chainId);
  if (existing) return existing;

  const chains = state.config.chains ?? DEFAULT_CHAINS;
  const chain = getChainById(chainId, chains);
  const rpcUrl = state.config.rpcUrls?.[chainId];
  const client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  state.publicClients.set(chainId, client);
  return client;
}

export function getWalletClient(state: WalletState, chainId: number): WalletClient {
  const existing = state.walletClients.get(chainId);
  if (existing) return existing;

  const chains = state.config.chains ?? DEFAULT_CHAINS;
  const chain = getChainById(chainId, chains);
  const rpcUrl = state.config.rpcUrls?.[chainId];
  const client = createWalletClient({ chain, account: state.account, transport: http(rpcUrl) }) as WalletClient;
  state.walletClients.set(chainId, client);
  return client;
}

export function getAddress(state: WalletState): `0x${string}` {
  return state.account.address;
}

export async function getBalance(state: WalletState, chainId: number): Promise<bigint> {
  const publicClient = getPublicClient(state, chainId);
  return publicClient.getBalance({ address: state.account.address });
}

export async function pay(state: WalletState, invoice: Invoice): Promise<PaymentProof> {
  validateChainId(invoice.chainId, 'invoice');
  validateAddress(invoice.recipient, 'invoice recipient');

  if (invoice.token !== 'ETH' && invoice.token !== 'ETHEREUM') {
    throw new Error(`Token ${invoice.token} not supported yet`);
  }

  const amountStr = String(invoice.amount).trim();
  validateAmount(amountStr, 'invoice');

  const amount = parseEther(amountStr);
  const walletClient = getWalletClient(state, invoice.chainId);
  const publicClient = getPublicClient(state, invoice.chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const balance = await getBalance(state, invoice.chainId);
  if (balance < amount) {
    throw new Error(
      `Insufficient balance: have ${balance.toString()} wei, need ${amount.toString()} wei`
    );
  }

  const chains = state.config.chains ?? DEFAULT_CHAINS;
  const chain = getChainById(invoice.chainId, chains);

  const { nonce, release } = await acquireNonce(
    publicClient,
    state.account.address,
    invoice.chainId,
    state.nonceManager
  );

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain,
      to: invoice.recipient,
      value: amount,
      nonce,
    });
  } catch (err) {
    release(false);
    throw err;
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      release(false);
      throw new Error(`Transaction failed: ${txHash}`);
    }

    release(true);
    return { invoiceId: invoice.id, txHash, chainId: invoice.chainId };
  } catch (err) {
    release(false);
    throw err;
  }
}

export async function verifyPayment(
  state: WalletState,
  paymentProof: PaymentProof,
  invoice: Invoice
): Promise<boolean> {
  validateChainId(paymentProof.chainId, 'payment proof');
  validateChainId(invoice.chainId, 'invoice');
  validateAddress(invoice.recipient, 'invoice recipient');

  if (paymentProof.chainId !== invoice.chainId) {
    throw new Error('Payment proof chain ID does not match invoice chain ID');
  }

  if (!paymentProof.txHash || typeof paymentProof.txHash !== 'string') {
    throw new Error('Invalid transaction hash in payment proof');
  }

  const publicClient = getPublicClient(state, paymentProof.chainId);
  const receipt = await publicClient.getTransactionReceipt({ hash: paymentProof.txHash as `0x${string}` });

  if (!receipt) {
    throw new Error('Transaction receipt not found');
  }

  if (receipt.status !== 'success') {
    throw new Error('Transaction failed');
  }

  validateAmount(invoice.amount, 'invoice verification');

  if (invoice.token === 'ETH' || invoice.token === 'ETHEREUM') {
    const expectedAmount = parseEther(invoice.amount);

    if (!receipt.to) {
      throw new Error('Transaction is a contract creation, not a payment');
    }

    if (receipt.to.toLowerCase() !== invoice.recipient.toLowerCase()) {
      throw new Error('Transaction recipient does not match invoice recipient');
    }

    const tx = await publicClient.getTransaction({ hash: paymentProof.txHash as `0x${string}` });

    if (tx.value !== expectedAmount) {
      throw new Error(`Transaction amount ${tx.value.toString()} does not match invoice amount ${expectedAmount.toString()}`);
    }

    return true;
  }

  if (!invoice.tokenAddress) {
    throw new Error('ERC20 invoice must include tokenAddress');
  }

  const expectedAmount = parseEther(invoice.amount);
  const transferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === invoice.tokenAddress?.toLowerCase() &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  );

  if (transferLogs.length === 0) {
    throw new Error('No ERC20 Transfer event found from the specified token contract');
  }

  const validTransfer = transferLogs.some((log) => {
    const toAddress = log.topics[2];
    if (!toAddress) return false;
    const decodedTo = `0x${toAddress.slice(26).toLowerCase()}`;
    if (decodedTo !== invoice.recipient.toLowerCase()) return false;
    const transferValue = BigInt(log.data);
    return transferValue === expectedAmount;
  });

  if (!validTransfer) {
    throw new Error('No matching ERC20 Transfer event found with correct recipient and amount');
  }

  return true;
}

export interface BatchSettlementResult {
  aggregatedInvoice: AggregatedInvoice;
  txHash: string;
  success: boolean;
  error?: string;
}

export async function batchSettle(
  state: WalletState,
  invoices: Invoice[]
): Promise<BatchSettlementResult[]> {
  if (invoices.length === 0) {
    return [];
  }

  const aggregated = aggregateInvoices(invoices);
  const results: BatchSettlementResult[] = [];

  for (const group of aggregated) {
    try {
      const invoice: Invoice = {
        id: `batch-${Date.now()}`,
        jobId: group.jobIds.join(','),
        chainId: group.chainId,
        amount: group.totalAmount,
        token: group.token,
        recipient: group.recipient,
        validUntil: Date.now() + 3600000,
      };

      const proof = await pay(state, invoice);
      results.push({
        aggregatedInvoice: group,
        txHash: proof.txHash,
        success: true,
      });
    } catch (err) {
      results.push({
        aggregatedInvoice: group,
        txHash: '',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
