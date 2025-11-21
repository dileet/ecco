import { Effect, Context, Layer, Ref, Schedule, Duration } from 'effect';
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEther } from 'viem';
import { sepolia, baseSepolia } from 'viem/chains';
import type { Invoice, PaymentProof } from '../types';
import { WalletError, PaymentVerificationError } from '../errors';
import type { NodeState } from '../node/types';

const ETH_SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface WalletConfig {
  privateKey?: `0x${string}`;
  chains?: Chain[];
  rpcUrls?: Record<number, string>;
}

export interface WalletState {
  config: WalletConfig;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClients: Map<number, PublicClient>;
  walletClients: Map<number, WalletClient>;
}

export class WalletService extends Context.Tag("WalletService")<
  WalletService,
  {
    readonly createState: (config: WalletConfig) => Effect.Effect<Ref.Ref<WalletState>, WalletError>;
    readonly getPublicClient: (
      stateRef: Ref.Ref<WalletState>,
      chainId: number
    ) => Effect.Effect<PublicClient, WalletError>;
    readonly getWalletClient: (
      stateRef: Ref.Ref<WalletState>,
      chainId: number
    ) => Effect.Effect<WalletClient, WalletError>;
    readonly pay: (
      stateRef: Ref.Ref<WalletState>,
      invoice: Invoice
    ) => Effect.Effect<PaymentProof, WalletError>;
    readonly verifyPayment: (
      stateRef: Ref.Ref<WalletState>,
      paymentProof: PaymentProof,
      invoice: Invoice
    ) => Effect.Effect<boolean, PaymentVerificationError>;
    readonly getAddress: (
      stateRef: Ref.Ref<WalletState>
    ) => Effect.Effect<`0x${string}`, WalletError>;
  }
>() {}

function getChainById(chainId: number, chains: Chain[]): Chain {
  const chain = chains.find((c) => c.id === chainId);
  if (chain) {
    return chain;
  }
  if (chainId === sepolia.id) {
    return sepolia;
  }
  if (chainId === baseSepolia.id) {
    return baseSepolia;
  }
  throw new Error(`Chain ${chainId} not found. Supported chains: Ethereum Sepolia (${sepolia.id}), Base Sepolia (${baseSepolia.id})`);
}

function createPublicClientForChain(chain: Chain, rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

function createWalletClientForChain(
  chain: Chain,
  account: ReturnType<typeof privateKeyToAccount>,
  rpcUrl?: string
): WalletClient {
  return createWalletClient({
    chain,
    account,
    transport: http(rpcUrl),
  });
}

export const WalletServiceLive = Layer.succeed(WalletService, {
  createState: (config: WalletConfig) =>
    Effect.gen(function* () {
      if (!config.privateKey) {
        return yield* Effect.fail(
          new WalletError({
            message: 'Private key is required',
            operation: 'createState',
          })
        );
      }

      const account = privateKeyToAccount(config.privateKey);
      const chains = config.chains || [sepolia, baseSepolia];
      const publicClients = new Map<number, PublicClient>();
      const walletClients = new Map<number, WalletClient>();

      for (const chain of chains) {
        const rpcUrl = config.rpcUrls?.[chain.id];
        publicClients.set(chain.id, createPublicClientForChain(chain, rpcUrl));
        walletClients.set(chain.id, createWalletClientForChain(chain, account, rpcUrl));
      }

      return yield* Ref.make<WalletState>({
        config: { privateKey: config.privateKey, chains: config.chains, rpcUrls: config.rpcUrls },
        account,
        publicClients,
        walletClients,
      });
    }),

  getPublicClient: (stateRef: Ref.Ref<WalletState>, chainId: number) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      const existing = state.publicClients.get(chainId);
      if (existing) {
        return existing;
      }

      const chains = state.config.chains || [sepolia, baseSepolia];
      const chain = getChainById(chainId, chains);
      const rpcUrl = state.config.rpcUrls?.[chainId];
      const client = createPublicClientForChain(chain, rpcUrl);

      const newPublicClients = new Map(state.publicClients);
      newPublicClients.set(chainId, client);
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        publicClients: newPublicClients,
      }));

      return client;
    }).pipe(
      Effect.mapError(
        (error) =>
          new WalletError({
            message: `Failed to get public client for chain ${chainId}`,
            operation: 'getClient',
            cause: error,
          })
      )
    ),

  getWalletClient: (stateRef: Ref.Ref<WalletState>, chainId: number) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      const existing = state.walletClients.get(chainId);
      if (existing) {
        return existing;
      }

      const chains = state.config.chains || [sepolia, baseSepolia];
      const chain = getChainById(chainId, chains);
      const rpcUrl = state.config.rpcUrls?.[chainId];
      const client = createWalletClientForChain(chain, state.account, rpcUrl);

      const newWalletClients = new Map(state.walletClients);
      newWalletClients.set(chainId, client);
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        walletClients: newWalletClients,
      }));

      return client;
    }).pipe(
      Effect.mapError(
        (error) =>
          new WalletError({
            message: `Failed to get wallet client for chain ${chainId}`,
            operation: 'getClient',
            cause: error,
          })
      )
    ),

  pay: (stateRef: Ref.Ref<WalletState>, invoice: Invoice) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      const existing = state.walletClients.get(invoice.chainId);
      let walletClient: WalletClient;
      if (existing) {
        walletClient = existing;
      } else {
        const chains = state.config.chains || [sepolia, baseSepolia];
        const chain = getChainById(invoice.chainId, chains);
        const rpcUrl = state.config.rpcUrls?.[invoice.chainId];
        walletClient = createWalletClientForChain(chain, state.account, rpcUrl);

        const newWalletClients = new Map(state.walletClients);
        newWalletClients.set(invoice.chainId, walletClient);
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          walletClients: newWalletClients,
        }));
      }

      let amount: bigint;
      if (invoice.token === 'ETH' || invoice.token === 'ETHEREUM') {
        const amountStr = String(invoice.amount).trim();
        if (!amountStr || isNaN(Number(amountStr))) {
          return yield* Effect.fail(
            new WalletError({
              message: `Invalid amount format: "${invoice.amount}"`,
              operation: 'pay',
            })
          );
        }
        try {
          amount = parseEther(amountStr);
        } catch (error) {
          return yield* Effect.fail(
            new WalletError({
              message: `Failed to parse amount "${invoice.amount}": ${error instanceof Error ? error.message : String(error)}`,
              operation: 'pay',
              cause: error,
            })
          );
        }
      } else {
        return yield* Effect.fail(
          new WalletError({
            message: `Token ${invoice.token} not supported yet`,
            operation: 'pay',
          })
        );
      }

      const txHash = yield* Effect.tryPromise({
        try: async () => {
          if (invoice.token === 'ETH' || invoice.token === 'ETHEREUM') {
            if (!walletClient.account) {
              throw new Error('Wallet client account not available');
            }
            const chains = state.config.chains || [sepolia, baseSepolia];
            const chain = getChainById(invoice.chainId, chains);
            const rpcUrl = state.config.rpcUrls?.[invoice.chainId];
            if (rpcUrl && (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://'))) {
              throw new Error(`Invalid RPC URL format: ${rpcUrl}. Must start with http:// or https://`);
            }
            return await walletClient.sendTransaction({
              account: walletClient.account,
              chain,
              to: invoice.recipient as `0x${string}`,
              value: amount,
            });
          } else {
            throw new Error(`Token ${invoice.token} not supported yet`);
          }
        },
        catch: (error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const rpcUrl = state.config.rpcUrls?.[invoice.chainId];
          const chains = state.config.chains || [sepolia, baseSepolia];
          const chain = getChainById(invoice.chainId, chains);
          let enhancedMessage = `Failed to send payment transaction: ${errorMessage}`;
          if (errorMessage.includes('Failed to parse JSON') || errorMessage.includes('HTTP request failed')) {
            enhancedMessage += `\n  Chain: ${chain.name} (id: ${invoice.chainId})`;
            enhancedMessage += `\n  This usually means the RPC URL is invalid or doesn't match the chain.`;
            if (rpcUrl) {
              enhancedMessage += `\n  RPC URL used: ${rpcUrl}`;
              const isBaseSepoliaRpc = rpcUrl.includes('base-sepolia') || rpcUrl.includes('base.org');
              const isEthSepoliaRpc = rpcUrl.includes('eth-sepolia') || rpcUrl.includes('sepolia.infura') || rpcUrl.includes('rpc.sepolia.org');
              if (invoice.chainId === ETH_SEPOLIA_CHAIN_ID && isBaseSepoliaRpc) {
                enhancedMessage += `\n  ERROR: You're using a Base Sepolia RPC URL for Ethereum Sepolia!`;
                enhancedMessage += `\n  Use RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
              } else if (invoice.chainId === BASE_SEPOLIA_CHAIN_ID && isEthSepoliaRpc) {
                enhancedMessage += `\n  ERROR: You're using an Ethereum Sepolia RPC URL for Base Sepolia!`;
                enhancedMessage += `\n  Use BASE_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
              } else {
                enhancedMessage += `\n  Check that your RPC URL is correct and the API key (if required) is valid.`;
              }
            } else {
              enhancedMessage += `\n  No custom RPC URL provided - using default public endpoint.`;
              enhancedMessage += `\n  Consider setting RPC_URL env var for better reliability.`;
            }
          }
          return new WalletError({
            message: enhancedMessage,
            operation: 'pay',
            cause: error,
          });
        },
      });

      return {
        invoiceId: invoice.id,
        txHash,
        chainId: invoice.chainId,
      };
    }),

  verifyPayment: (
    stateRef: Ref.Ref<WalletState>,
    paymentProof: PaymentProof,
    invoice: Invoice
  ) =>
    Effect.gen(function* () {
      if (paymentProof.chainId !== invoice.chainId) {
        return yield* Effect.fail(
          new PaymentVerificationError({
            message: 'Payment proof chain ID does not match invoice chain ID',
            txHash: paymentProof.txHash,
            chainId: paymentProof.chainId,
          })
        );
      }

      const state = yield* Ref.get(stateRef);

      const existing = state.publicClients.get(paymentProof.chainId);
      let publicClient: PublicClient;
      if (existing) {
        publicClient = existing;
      } else {
        const chains = state.config.chains || [sepolia, baseSepolia];
        const chain = getChainById(paymentProof.chainId, chains);
        const rpcUrl = state.config.rpcUrls?.[paymentProof.chainId];
        publicClient = createPublicClientForChain(chain, rpcUrl);

        const newPublicClients = new Map(state.publicClients);
        newPublicClients.set(paymentProof.chainId, publicClient);
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          publicClients: newPublicClients,
        }));
      }

      const getReceipt = Effect.tryPromise({
        try: async () => {
          return await publicClient.getTransactionReceipt({
            hash: paymentProof.txHash as `0x${string}`,
          });
        },
        catch: (error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes('Transaction receipt') &&
            (errorMessage.includes('not found') ||
              errorMessage.includes('could not be found') ||
              errorMessage.includes('may not be processed on a block yet'))
          ) {
            return new PaymentVerificationError({
              message: 'Transaction receipt not yet available',
              txHash: paymentProof.txHash,
              chainId: paymentProof.chainId,
              cause: error,
            });
          }
          const rpcUrl = state.config.rpcUrls?.[paymentProof.chainId];
          const chains = state.config.chains || [sepolia, baseSepolia];
          const chain = getChainById(paymentProof.chainId, chains);
          let enhancedMessage = `Failed to get transaction receipt: ${errorMessage}`;
          if (errorMessage.includes('Failed to parse JSON') || errorMessage.includes('HTTP request failed')) {
            enhancedMessage += `\n  Chain: ${chain.name} (id: ${paymentProof.chainId})`;
            enhancedMessage += `\n  This usually means the RPC URL is invalid or doesn't match the chain.`;
            if (rpcUrl) {
              enhancedMessage += `\n  RPC URL used: ${rpcUrl}`;
              const isBaseSepoliaRpc = rpcUrl.includes('base-sepolia') || rpcUrl.includes('base.org');
              const isEthSepoliaRpc = rpcUrl.includes('eth-sepolia') || rpcUrl.includes('sepolia.infura') || rpcUrl.includes('rpc.sepolia.org');
              if (paymentProof.chainId === ETH_SEPOLIA_CHAIN_ID && isBaseSepoliaRpc) {
                enhancedMessage += `\n  ERROR: You're using a Base Sepolia RPC URL for Ethereum Sepolia!`;
                enhancedMessage += `\n  Use RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
              } else if (paymentProof.chainId === BASE_SEPOLIA_CHAIN_ID && isEthSepoliaRpc) {
                enhancedMessage += `\n  ERROR: You're using an Ethereum Sepolia RPC URL for Base Sepolia!`;
                enhancedMessage += `\n  Use BASE_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
              } else {
                enhancedMessage += `\n  Check that your RPC URL is correct and the API key (if required) is valid.`;
              }
            }
          }
          return new PaymentVerificationError({
            message: enhancedMessage,
            txHash: paymentProof.txHash,
            chainId: paymentProof.chainId,
            cause: error,
          });
        },
      });

      const receipt = yield* getReceipt.pipe(
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(2000)).pipe(
            Schedule.intersect(Schedule.recurs(30)),
            Schedule.union(Schedule.spaced(Duration.millis(10000)))
          ),
          while: (error) => {
            if (error instanceof PaymentVerificationError && error.message.includes('not yet available')) {
              return true;
            }
            return false;
          },
        })
      );

      if (receipt.status !== 'success') {
        return yield* Effect.fail(
          new PaymentVerificationError({
            message: 'Transaction failed',
            txHash: paymentProof.txHash,
            chainId: paymentProof.chainId,
          })
        );
      }

      if (invoice.token === 'ETH' || invoice.token === 'ETHEREUM') {
        let expectedAmount: bigint;
        try {
          expectedAmount = parseEther(invoice.amount);
        } catch (error) {
          return yield* Effect.fail(
            new PaymentVerificationError({
              message: `Failed to parse invoice amount: ${invoice.amount}`,
              txHash: paymentProof.txHash,
              chainId: paymentProof.chainId,
              cause: error,
            })
          );
        }
        if (receipt.to?.toLowerCase() !== invoice.recipient.toLowerCase()) {
          return yield* Effect.fail(
            new PaymentVerificationError({
              message: 'Transaction recipient does not match invoice recipient',
              txHash: paymentProof.txHash,
              chainId: paymentProof.chainId,
            })
          );
        }

        const tx = yield* Effect.tryPromise({
          try: async () => {
            return await publicClient.getTransaction({
              hash: paymentProof.txHash as `0x${string}`,
            });
          },
          catch: (error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const rpcUrl = state.config.rpcUrls?.[paymentProof.chainId];
            const chains = state.config.chains || [sepolia, baseSepolia];
            const chain = getChainById(paymentProof.chainId, chains);
            let enhancedMessage = `Failed to get transaction details: ${errorMessage}`;
            if (errorMessage.includes('Failed to parse JSON') || errorMessage.includes('HTTP request failed')) {
              enhancedMessage += `\n  Chain: ${chain.name} (id: ${paymentProof.chainId})`;
              enhancedMessage += `\n  This usually means the RPC URL is invalid or doesn't match the chain.`;
              if (rpcUrl) {
                enhancedMessage += `\n  RPC URL used: ${rpcUrl}`;
                const isBaseSepoliaRpc = rpcUrl.includes('base-sepolia') || rpcUrl.includes('base.org');
                const isEthSepoliaRpc = rpcUrl.includes('eth-sepolia') || rpcUrl.includes('sepolia.infura') || rpcUrl.includes('rpc.sepolia.org');
                if (paymentProof.chainId === ETH_SEPOLIA_CHAIN_ID && isBaseSepoliaRpc) {
                  enhancedMessage += `\n  ERROR: You're using a Base Sepolia RPC URL for Ethereum Sepolia!`;
                  enhancedMessage += `\n  Use RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
                } else if (paymentProof.chainId === BASE_SEPOLIA_CHAIN_ID && isEthSepoliaRpc) {
                  enhancedMessage += `\n  ERROR: You're using an Ethereum Sepolia RPC URL for Base Sepolia!`;
                  enhancedMessage += `\n  Use BASE_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY instead.`;
                } else {
                  enhancedMessage += `\n  Check that your RPC URL is correct and the API key (if required) is valid.`;
                }
              }
            }
            return new PaymentVerificationError({
              message: enhancedMessage,
              txHash: paymentProof.txHash,
              chainId: paymentProof.chainId,
              cause: error,
            });
          },
        });

        if (tx.value !== expectedAmount) {
          return yield* Effect.fail(
            new PaymentVerificationError({
              message: `Transaction amount ${tx.value.toString()} does not match invoice amount ${expectedAmount.toString()}`,
              txHash: paymentProof.txHash,
              chainId: paymentProof.chainId,
            })
          );
        }
      }

      return true;
    }),

  getAddress: (stateRef: Ref.Ref<WalletState>) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      return state.account.address;
    }),
});

export namespace Wallet {
  export async function initialize(
    nodeState: NodeState,
    config?: WalletConfig
  ): Promise<NodeState> {
    if (!nodeState._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }

    const { getState } = await import('../node/state-ref');
    const currentState = await Effect.runPromise(getState(nodeState._ref));

    if (currentState.walletRef) {
      return { ...currentState, _ref: nodeState._ref };
    }

    if (!config?.privateKey && !currentState.messageAuth) {
      throw new Error('Wallet requires either a privateKey in config or authentication to be enabled. If authentication is enabled, wallet is auto-initialized.');
    }

    if (!config?.privateKey) {
      throw new Error('Wallet already initialized via authentication, or provide a privateKey in config to override.');
    }

    const walletStateRef = await Effect.runPromise(
      WalletService.pipe(
        Effect.flatMap((service) => service.createState({
          privateKey: config.privateKey,
          chains: config.chains || [],
        })),
        Effect.provide(WalletServiceLive)
      )
    );

    const { setWalletRef } = await import('../node/state-ref');
    await Effect.runPromise(setWalletRef(nodeState._ref, walletStateRef));

    const updatedState = await Effect.runPromise(getState(nodeState._ref));
    return { ...updatedState, _ref: nodeState._ref };
  }

  export async function pay(
    nodeState: NodeState,
    invoice: Invoice
  ): Promise<PaymentProof> {
    if (!nodeState._ref || !nodeState.walletRef) {
      throw new Error('Wallet not initialized. Call Wallet.initialize() first.');
    }

    return await Effect.runPromise(
      WalletService.pipe(
        Effect.flatMap((service) => service.pay(nodeState.walletRef!, invoice)),
        Effect.provide(WalletServiceLive)
      )
    );
  }

  export async function verifyPayment(
    nodeState: NodeState,
    paymentProof: PaymentProof,
    invoice: Invoice
  ): Promise<boolean> {
    if (!nodeState._ref || !nodeState.walletRef) {
      throw new Error('Wallet not initialized. Call Wallet.initialize() first.');
    }

    return await Effect.runPromise(
      WalletService.pipe(
        Effect.flatMap((service) =>
          service.verifyPayment(nodeState.walletRef!, paymentProof, invoice)
        ),
        Effect.provide(WalletServiceLive)
      )
    );
  }

  export async function getAddress(nodeState: NodeState): Promise<`0x${string}`> {
    if (!nodeState._ref || !nodeState.walletRef) {
      throw new Error('Wallet not initialized. Call Wallet.initialize() first.');
    }

    return await Effect.runPromise(
      WalletService.pipe(
        Effect.flatMap((service) => service.getAddress(nodeState.walletRef!)),
        Effect.provide(WalletServiceLive)
      )
    );
  }
}
