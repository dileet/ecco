import { createInitialState, start, stop, subscribeToTopic, getId, findPeers, sendMessage, publish, type StateRef, type NodeState, PaymentProtocol, Wallet, type EccoEvent, type MessageEvent } from '@ecco/core';
import type { Invoice, PaymentProof, QuoteRequest } from '@ecco/core';

const BASE_SEPOLIA_CHAIN_ID = 84532;
const ETH_SEPOLIA_CHAIN_ID = 11155111;

const SERVICE_KEY_PATH = '.keys/service-agent.json';
const CLIENT_KEY_PATH = '.keys/client-agent.json';

async function createServiceAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
    discovery: registryUrl ? ['mdns', 'gossip', 'registry'] : ['mdns', 'gossip'],
    registry: registryUrl,
    nodeId: id,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: SERVICE_KEY_PATH,
      walletRpcUrls,
    },
    capabilities: [
      {
        type: 'scraper',
        name: 'premium-joke-service',
        version: '1.0.0',
        metadata: {
          pricing: [
            {
              chainId: ETH_SEPOLIA_CHAIN_ID,
              token: 'ETH',
              amount: '0.0001',
            },
          ],
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  const agentRef = await start(agentState);

  const walletAddress = await Wallet.getAddress(agentRef);
  console.log(`[${id}] Wallet address: ${walletAddress}`);
  console.log(`[${id}] Network: Ethereum Sepolia (Chain ID: ${ETH_SEPOLIA_CHAIN_ID})`);
  console.log(`[${id}] Send Ethereum Sepolia testnet ETH:`);
  console.log(`[${id}]   - Google Cloud: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
  console.log(`[${id}]   - Alchemy: https://sepoliafaucet.com/`);
  console.log(`[${id}]   - QuickNode: https://faucet.quicknode.com/ethereum/sepolia\n`);

  const pendingInvoices = new Map<string, Invoice>();

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as { type: string; payload: unknown };

    if (PaymentProtocol.isRequestQuoteMessage(message)) {
      const quoteRequest = message.payload as QuoteRequest;
      console.log(`[${id}] Received quote request for: ${quoteRequest.jobType}`);

      const address = await Wallet.getAddress(agentRef);

      const invoice = PaymentProtocol.createInvoice(
        `job-${Date.now()}`,
        ETH_SEPOLIA_CHAIN_ID,
        '0.0001',
        'ETH',
        address,
        Date.now() + 300000
      );

      pendingInvoices.set(invoice.id, invoice);

      const invoiceMessage = PaymentProtocol.createInvoiceMessage(
        getId(agentRef),
        event.from,
        invoice
      );

      await sendMessage(agentRef, event.from, invoiceMessage);
      console.log(`[${id}] Sent invoice: ${invoice.id}`);
    }

    if (PaymentProtocol.isPaymentProofMessage(message)) {
      const paymentProof = message.payload as PaymentProof;
      console.log(`[${id}] Received payment proof for invoice: ${paymentProof.invoiceId}`);

      const invoice = pendingInvoices.get(paymentProof.invoiceId);
      if (!invoice) {
        const errorMessage = PaymentProtocol.createPaymentFailedMessage(
          getId(agentRef),
          event.from,
          paymentProof.invoiceId,
          'Invoice not found'
        );
        await sendMessage(agentRef, event.from, errorMessage);
        return;
      }

      try {
        console.log(`[${id}] Verifying payment for invoice: ${paymentProof.invoiceId}`);
        console.log(`[${id}] Transaction hash: ${paymentProof.txHash}`);
        console.log(`[${id}] Chain ID: ${paymentProof.chainId}`);
        const isValid = await Wallet.verifyPayment(agentRef, paymentProof, invoice);
        if (!isValid) {
          const errorMessage = PaymentProtocol.createPaymentFailedMessage(
            getId(agentRef),
            event.from,
            paymentProof.invoiceId,
            'Payment verification failed: verification returned false'
          );
          await sendMessage(agentRef, event.from, errorMessage);
          console.log(`[${id}] Payment verification failed for invoice: ${paymentProof.invoiceId} (returned false)`);
          return;
        }
        console.log(`[${id}] Payment verification successful!`);
      } catch (error) {
        const errorDetails = error instanceof Error ? error.message : String(error);
        console.error(`[${id}] Payment verification error for invoice: ${paymentProof.invoiceId}`);
        console.error(`[${id}] Error details:`, errorDetails);
        if (error instanceof Error && error.cause) {
          console.error(`[${id}] Error cause:`, error.cause);
        }
        const errorMessage = PaymentProtocol.createPaymentFailedMessage(
          getId(agentRef),
          event.from,
          paymentProof.invoiceId,
          `Payment verification failed: ${errorDetails}`
        );
        await sendMessage(agentRef, event.from, errorMessage);
        console.log(`[${id}] Payment verification failed for invoice: ${paymentProof.invoiceId}`);
        return;
      }

      console.log(`[${id}] Payment verified! Performing work for invoice: ${paymentProof.invoiceId}`);

      const joke = `Why did the blockchain break up? Because it couldn't handle the commitment! 😄`;

      const verifiedMessage = PaymentProtocol.createPaymentVerifiedMessage(
        getId(agentRef),
        event.from,
        paymentProof.invoiceId
      );
      await sendMessage(agentRef, event.from, verifiedMessage);

      const resultEvent: MessageEvent = {
        type: 'message',
        from: getId(agentRef),
        to: event.from,
        payload: {
          invoiceId: paymentProof.invoiceId,
          result: joke,
        },
        timestamp: Date.now(),
      };

      await publish(agentRef, `result:${paymentProof.invoiceId}`, resultEvent);
      console.log(`[${id}] Work completed and result sent`);

      pendingInvoices.delete(paymentProof.invoiceId);
    }
  });

  console.log(`[${id}] Service agent started on port ${port}`);
  return agentRef;
}

async function createClientAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
    discovery: registryUrl ? ['mdns', 'gossip', 'registry'] : ['mdns', 'gossip'],
    registry: registryUrl,
    nodeId: id,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: CLIENT_KEY_PATH,
      walletRpcUrls,
    },
    capabilities: [],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  const agentRef = await start(agentState);

  const walletAddress = await Wallet.getAddress(agentRef);
  console.log(`[${id}] Wallet address: ${walletAddress}`);
  console.log(`[${id}] Network: Ethereum Sepolia (Chain ID: ${ETH_SEPOLIA_CHAIN_ID})`);
  console.log(`[${id}] Send Ethereum Sepolia testnet ETH:`);
  console.log(`[${id}]   - Google Cloud: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
  console.log(`[${id}]   - Alchemy: https://sepoliafaucet.com/`);
  console.log(`[${id}]   - QuickNode: https://faucet.quicknode.com/ethereum/sepolia\n`);

  console.log(`[${id}] Client agent started on port ${port}`);
  return agentRef;
}

async function requestService(
  agentRef: StateRef<NodeState>,
  servicePeerId: string
): Promise<void> {

  console.log(`\n[${getId(agentRef)}] Requesting service from ${servicePeerId}`);

  const quoteRequest = PaymentProtocol.createQuoteRequest('joke', {});
  const quoteMessage = PaymentProtocol.createRequestQuoteMessage(
    getId(agentRef),
    servicePeerId,
    quoteRequest
  );

  let invoice: Invoice | null = null;
  let paymentProof: PaymentProof | null = null;

  let invoiceResolve: ((invoice: Invoice) => void) | null = null;
  let invoiceReject: ((error: Error) => void) | null = null;

  const invoiceHandler = (event: EccoEvent) => {
    if (event.type !== 'message') return;

    const message = event.payload as { type: string; payload: unknown };
    if (PaymentProtocol.isInvoiceMessage(message) && invoiceResolve) {
      invoiceResolve(message.payload as Invoice);
      invoiceResolve = null;
      invoiceReject = null;
    }
  };

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, invoiceHandler);

  const invoicePromise = new Promise<Invoice>((resolve, reject) => {
    invoiceResolve = resolve;
    invoiceReject = reject;
    setTimeout(() => {
      if (invoiceReject) {
        invoiceReject(new Error('Invoice timeout'));
        invoiceResolve = null;
        invoiceReject = null;
      }
    }, 10000);
  });

  await sendMessage(agentRef, servicePeerId, quoteMessage);
  console.log(`[${getId(agentRef)}] Quote request sent`);

  try {
    invoice = await invoicePromise;
    console.log(`[${getId(agentRef)}] Received invoice: ${invoice.id}`);
    console.log(`  Amount: ${invoice.amount} ${invoice.token}`);
    console.log(`  Chain: ${invoice.chainId}`);
    console.log(`  Recipient: ${invoice.recipient}`);

    try {
      await PaymentProtocol.validateInvoiceAsync(invoice);
    } catch (error) {
      console.error(`[${getId(agentRef)}] Invoice expired:`, (error as Error).message);
      return;
    }

    console.log(`[${getId(agentRef)}] Paying invoice...`);

    try {
      paymentProof = await Wallet.pay(agentRef, invoice!);
    } catch (error) {
      console.error(`[${getId(agentRef)}] Payment failed:`, error instanceof Error ? error.message : String(error));
      console.error(`[${getId(agentRef)}] Full error:`, error);
      throw error;
    }

    console.log(`[${getId(agentRef)}] Payment sent! TX Hash: ${paymentProof.txHash}`);

    let resultResolve: ((result: string) => void) | null = null;
    let resultReject: ((error: Error) => void) | null = null;

    const resultHandler = (resultEvent: EccoEvent) => {
      if (resultEvent.type === 'message') {
        const messageEvent = resultEvent as MessageEvent;
        if (
          typeof messageEvent.payload === 'object' &&
          messageEvent.payload !== null &&
          'result' in messageEvent.payload &&
          resultResolve
        ) {
          resultResolve((messageEvent.payload as { result: string }).result);
          resultResolve = null;
          resultReject = null;
        }
      }
    };

    subscribeToTopic(agentRef, `result:${invoice!.id}`, resultHandler);
    console.log(`[${getId(agentRef)}] Subscribed to result topic: result:${invoice!.id}`);

    const proofMessage = PaymentProtocol.createPaymentProofMessage(
      getId(agentRef),
      servicePeerId,
      paymentProof
    );

    await sendMessage(agentRef, servicePeerId, proofMessage);
    console.log(`[${getId(agentRef)}] Payment proof sent`);

    const verifiedHandler = (event: EccoEvent) => {
      if (event.type !== 'message') return;

      const message = event.payload as { type: string; payload: unknown };
      if (
        message.type === 'payment-verified' &&
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'invoiceId' in message.payload &&
        (message.payload as { invoiceId: string }).invoiceId === invoice!.id
      ) {
        console.log(`[${getId(agentRef)}] Payment verified, waiting for result...`);
      }
    };

    subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, verifiedHandler);

    const resultPromise = new Promise<string>((resolve, reject) => {
      resultResolve = resolve;
      resultReject = reject;
      setTimeout(() => {
        if (resultReject) {
          resultReject(new Error('Result timeout'));
          resultResolve = null;
          resultReject = null;
        }
      }, 30000);
    });

    const result = await resultPromise;
    console.log(`\n[${getId(agentRef)}] Service Result: ${result}\n`);
  } catch (error) {
    console.error(`[${getId(agentRef)}] Error:`, (error as Error).message);
  }
}

async function main() {
  console.log('=== Native Crypto Economy Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Service Agent advertises paid service with pricing');
  console.log('2. Client Agent requests quote');
  console.log('3. Service Agent sends invoice');
  console.log('4. Client Agent pays on-chain (Ethereum Sepolia)');
  console.log('5. Service Agent verifies payment and performs work\n');
  console.log('NOTE: Wallet addresses will be displayed when agents start.');
  console.log('      Make sure the CLIENT agent has testnet ETH before payments!\n');

  const registryUrl = process.env.REGISTRY_URL;
  const ethRpcUrl = process.env.RPC_URL;
  const baseRpcUrl = process.env.BASE_RPC_URL;

  const walletRpcUrls: Record<number, string> = {};
  
  if (ethRpcUrl) {
    if (!ethRpcUrl.startsWith('http://') && !ethRpcUrl.startsWith('https://')) {
      console.error('ERROR: Invalid RPC_URL format. Must start with http:// or https://');
      console.error(`  Provided: ${ethRpcUrl}`);
      process.exit(1);
    }
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = ethRpcUrl;
    console.log(`Using Ethereum Sepolia RPC: ${ethRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***').replace(/\/v3\/[^/]+$/, '/v3/***')}`);
  } else {
    console.warn('WARNING: No RPC_URL provided for Ethereum Sepolia. Using default public RPC endpoint.');
  }

  if (baseRpcUrl) {
    if (!baseRpcUrl.startsWith('http://') && !baseRpcUrl.startsWith('https://')) {
      console.error('ERROR: Invalid BASE_RPC_URL format. Must start with http:// or https://');
      console.error(`  Provided: ${baseRpcUrl}`);
      process.exit(1);
    }
    walletRpcUrls[BASE_SEPOLIA_CHAIN_ID] = baseRpcUrl;
    console.log(`Using Base Sepolia RPC: ${baseRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***').replace(/\/v3\/[^/]+$/, '/v3/***')}`);
  }

  if (Object.keys(walletRpcUrls).length === 0) {
    console.warn('\nWARNING: No custom RPC URLs provided. Using default public endpoints.\n');
    console.warn('For better performance and reliability, set RPC_URL env var:\n');
    console.warn('  Ethereum Sepolia: RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY');
    console.warn('  Base Sepolia:     BASE_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY\n');
  } else {
    console.log('');
  }

  const serviceAgentRef = await createServiceAgent('service-agent', 7771, registryUrl, walletRpcUrls);
  const clientAgentRef = await createClientAgent('client-agent', 7772, registryUrl, walletRpcUrls);

  console.log('\nWaiting for peers to discover...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const matches = await findPeers(clientAgentRef, {
    requiredCapabilities: [
      {
        type: 'scraper',
        name: 'premium-joke-service',
      },
    ],
  });

  if (matches.length === 0) {
    console.error('Service agent not found!');
    await stop(serviceAgentRef);
    await stop(clientAgentRef);
    return;
  }

  const servicePeer = matches[0].peer;
  console.log(`Found service peer: ${servicePeer.id} (${getId(serviceAgentRef)})\n`);

  await requestService(clientAgentRef, servicePeer.id);

  await stop(serviceAgentRef);
  await stop(clientAgentRef);

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);
