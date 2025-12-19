import { createPublicClient, createWalletClient, defineChain, http, type PublicClient, type WalletClient, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEther } from 'viem';
import type { Invoice, PaymentProof } from '../types';
import { aggregateInvoices, type AggregatedInvoice } from './payment';

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

  for (const chain of chains) {
    const rpcUrl = config.rpcUrls?.[chain.id];
    publicClients.set(chain.id, createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient);
    walletClients.set(chain.id, createWalletClient({ chain, account, transport: http(rpcUrl) }) as WalletClient);
  }

  return { config, account, publicClients, walletClients };
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

export async function pay(state: WalletState, invoice: Invoice): Promise<PaymentProof> {
  if (invoice.token !== 'ETH' && invoice.token !== 'ETHEREUM') {
    throw new Error(`Token ${invoice.token} not supported yet`);
  }

  const amountStr = String(invoice.amount).trim();
  if (!amountStr || isNaN(Number(amountStr))) {
    throw new Error(`Invalid amount format: "${invoice.amount}"`);
  }

  const amount = parseEther(amountStr);
  const walletClient = getWalletClient(state, invoice.chainId);
  
  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const chains = state.config.chains ?? DEFAULT_CHAINS;
  const chain = getChainById(invoice.chainId, chains);

  const txHash = await walletClient.sendTransaction({
    account: walletClient.account,
    chain,
    to: invoice.recipient as `0x${string}`,
    value: amount,
  });

  return { invoiceId: invoice.id, txHash, chainId: invoice.chainId };
}

export async function verifyPayment(
  state: WalletState,
  paymentProof: PaymentProof,
  invoice: Invoice
): Promise<boolean> {
  if (paymentProof.chainId !== invoice.chainId) {
    throw new Error('Payment proof chain ID does not match invoice chain ID');
  }

  const publicClient = getPublicClient(state, paymentProof.chainId);
  const receipt = await publicClient.getTransactionReceipt({ hash: paymentProof.txHash as `0x${string}` });

  if (receipt.status !== 'success') {
    throw new Error('Transaction failed');
  }

  if (invoice.token !== 'ETH' && invoice.token !== 'ETHEREUM') {
    return true;
  }

  const expectedAmount = parseEther(invoice.amount);

  if (receipt.to?.toLowerCase() !== invoice.recipient.toLowerCase()) {
    throw new Error('Transaction recipient does not match invoice recipient');
  }

  const tx = await publicClient.getTransaction({ hash: paymentProof.txHash as `0x${string}` });

  if (tx.value !== expectedAmount) {
    throw new Error(`Transaction amount ${tx.value.toString()} does not match invoice amount ${expectedAmount.toString()}`);
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
