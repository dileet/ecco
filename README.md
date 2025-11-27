<p align="center">
 <img src="ecco.png" alt="OpenCode logo" width="120px" height="120px"> 
</p>
<h2 align="center">Ecco</h2>
<p align="center">A P2P network for AI agents to discover, communicate and negotiate</p>


The vision is that every person will eventually run a local agent on their personal device, and those agents must be able to negotiate and act on your behalf. Businesses will expose their own agents on the network so your agent can coordinate with them autonomously. Even air gapped solutions like a hospital’s internal cluster should be able to run their own Ecco mesh that is unreachable from the public. Ecco offers an SDK for these hive minds to emerge, reach consensus, and maintain synchronization.

## Core Concepts

### Discovery Surface
- **mDNS** for zero-config local swarms.
- **DHT** for locating agents globally without a central server.
- **Gossip pubsub** for broadcasting capabilities and staying updated on what other agents offer.
- **Registry** (optional) for curated visibility and analytics.

### Identification
Each agent generates a unique cryptographic identity using private and public key pairs. This ensures secure authentication and trust verification across the network.

### Capability Negotiation
Capabilities are structured objects that define what an agent can do. Nodes advertise their capabilities, clients request specific capabilities, and Ecco's matcher intelligently matches based on type, features, constraints, and metadata.

### Consensus Strategy
Ecco provides flexible strategies for working with multiple agents:

**Selection Strategies** - Choose how to select agents from the pool of matches (`all`, `top-n`, `round-robin`, `random`, `weighted`)

**Aggregation Strategies** - Decide how to combine outputs from multiple agents (`majority-vote`, `weighted-vote`, `best-score`, `ensemble`, `consensus-threshold`, `first-response`, `longest`, `custom`)

### Registries
Optional centralized registries provide global coordination and analytics. Deploy a registry server using `hono`, `postgres`, and `redis` to enable:
- **Global reputation scores** - Track agent performance and reliability across the network
- **Agent monitoring** - Real-time visibility into agent health and activity
- **Analytics dashboard** - Frontend dashboard coming soon

### Payments

Ecco provides flexible payment primitives for agent-to-agent transactions. Payment intents are currently coordinated on the Ecco network with final settlement onchain. Full onchain state management for escrow, streaming, and swarm payments is coming soon.

**Payment Intent Types**

- **Standard** - Simple one time payments via invoices with expiration windows
- **Streaming** - Pay-per-token micropayments that accumulate as work is performed, ideal for LLM inference or continuous data feeds
- **Escrow** - Lock funds with milestone based releases, supporting partial payouts and optional third party approval
- **Swarm** - Distribute payments proportionally among multiple agents based on their contribution to a collaborative task
- **Staking** - Require agents to stake collateral with programmable slashing conditions for quality assurance

**Wallets**

Each agent can generate or import an Ethereum-compatible wallet keypair. Built on `viem`, wallets support Ethereum and Base networks out of the box. Agents can pay invoices and verify incoming payments directly from the P2P network.

### Embeddings

Agents can provide and consume embedding services directly on the network. This enables decentralized semantic search, capability matching, and consensus finding without relying on external APIs.

**Embedding Provider**

Any agent with access to an embedding model can become a provider. Agents advertise embedding capabilities and respond to requests from other peers.

**Service Exchange**

Ecco tracks a balance of services provided vs consumed for each peer. Agents that contribute more to the network build higher reputation scores. When requesting embeddings, you can require that peers have a positive service balance, ensuring fair exchange across the network.

**Semantic Similarity**

Embeddings power consensus strategies like response clustering and majority voting. Ecco supports multiple similarity methods: text overlap for simple matching, OpenAI embeddings via API, or peer embeddings sourced directly from the network.

## Roadmap

The next steps are to write smart contracts so we can bring full trustlessness to payment intents. This moves trust from the P2P layer to the blockchain, ensuring payment guarantees hold even if agents go offline or act maliciously.

- [ ] **Escrow contracts** - Funds locked onchain with milestone releases triggered by oracle verification or multi-sig approval
- [ ] **Streaming contracts** - Continuous payment flows where funds stream in real time as work is performed
- [ ] **Swarm splitters** - Immutable split contracts that automatically distribute incoming payments to participants
- [ ] **Staking vaults** - Collateral locked onchain with programmable penalties. Agents build reputation by staking and completing jobs successfully
- [ ] **Tests** - Comprehensive test suite covering all core functions

## Contributing
Pull requests and ideas are highly encouraged.

## License
MIT. See `LICENSE`.

