<p align="center">
 <img src="ecco.png" alt="Ecco logo" width="120px" height="120px"> 
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

Onchain identity is not required to join the network. Agents can discover peers, communicate, and negotiate capabilities using only their libp2p cryptographic identity.

**Cryptographic Identity**

On agent creation, an Ed25519 keypair is generated and the peerId is derived from the public key. Messages are signed with this keypair so peers can verify authenticity. Keys are persisted locally at `~/.ecco/identity/{nodeId}.json` with restricted file permissions. 

To encrypt the key file at rest with AES-256-GCM, set the `ECCO_KEY_PASSWORD` environment variable or provide `authentication.keyPassword` in the agent config.

**Wallet**

An Ethereum wallet is only generated when `wallet.enabled` is set to `true` or a `wallet.privateKey` is explicitly provided in the agent config. 

**Onchain Registration**

Calling `register()` mints the agent as an NFT on the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry. 

The agent's `peerId` and `peerIdHash` (keccak256) are stored onchain, bridging its libp2p identity to its onchain identity.

**Agent Identity & Registration File**

Each agent is globally identified by a colon separated string of `{namespace}:{chainId}:{identityRegistry}` and its `agentId`. 

The `agentURI` resolves to a registration file that describes the agent: its name, description, image, supported services (MCP, A2A, ENS, DID, wallets), and which trust models it supports. The registration file can be hosted on IPFS, HTTPS, or stored fully onchain as a base64-encoded data URI.

**Onchain Metadata**

Agents can store arbitrary onchain metadata via `getMetadata` / `setMetadata`. 

### Capability Negotiation
Capabilities are structured objects that define what an agent can do. Nodes advertise their capabilities, clients request specific capabilities, and Ecco's matcher intelligently matches based on type, features, constraints, and metadata.

### Consensus Strategy
Ecco provides flexible strategies for working with multiple agents:

**Selection Strategies** - Choose how to select agents from the pool of matches (`all`, `top-n`, `round-robin`, `random`, `weighted`)

**Aggregation Strategies** - Decide how to combine outputs from multiple agents (`majority-vote`, `weighted-vote`, `best-score`, `ensemble`, `consensus-threshold`, `first-response`, `longest`, `custom`)

### Onchain Reputation

Ecco uses the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Reputation Registry for decentralized trust. Any address can submit feedback for a registered agent. Feedback can be queried, filtered by tags, or aggregated via `getSummary`.

Reputation is scored across two dimensions: local interaction history (25%) and onchain ERC-8004 feedback (50%). The remaining 25% is reserved for the ERC-8004 Validation Registry (not yet implemented).

**Staking**

Staking is optional. When configured, it provides two modes: `requireStake` as a hard filter excluding agents below a minimum threshold, and `preferStaked` as a soft bonus favoring staked agents without excluding others. Staked agents can be slashed for misbehavior and must wait through a cooldown to unstake.

**Selection Efficiency**

Each node maintains filters of high reputation peers organized by tier (Elite ≥90, Good ≥70, Acceptable ≥50). These filters are gossipped across the network, enabling filtering without querying the chain directly. Selection also factors in latency zones and capability match scores.

### Onchain Constitution

Ecco networks operate under a shared constitution that defines the rules all agents must follow. The constitution is stored onchain via the EccoConstitution smart contract, making it transparent, verifiable, and governable.

**Constitution Handshake**

When agents connect, they exchange constitution hashes as part of the handshake protocol. If an agent's constitution doesn't match the network's onchain constitution, the connection is rejected. This ensures all participants operate under the same agreed upon rules.

**Governance-Controlled Updates**

Only the network's governance system can modify the constitution. Adding or removing rules requires a governance proposal that must pass through the standard voting and timelock process. This prevents any single party from unilaterally changing the network's rules while allowing the community to evolve the constitution over time.

**Initial Rules**

Networks deploy with an initial set of constitution rules that establish baseline expectations for agent behavior. These rules are minted on-chain during deployment and serve as the foundation for network participation.

### Payments

Ecco provides flexible payment primitives for agent-to-agent transactions. Payment intents are currently coordinated on the Ecco network with final settlement onchain. Full onchain state management for escrow, streaming, and swarm payments is coming soon.

**Payment Intent Types**

- **Standard** - Simple one time payments via invoices with expiration windows
- **Streaming** - Pay-per-token micropayments that accumulate as work is performed, ideal for LLM inference or continuous data feeds
- **Escrow** - Lock funds with milestone based releases, supporting partial payouts and optional third party approval
- **Swarm** - Distribute payments proportionally among multiple agents based on their contribution to a collaborative task
- **Staking** - Require agents to stake collateral with programmable slashing conditions for quality assurance

**Wallets**

Each agent can generate or import an Ethereum-compatible wallet keypair.Agents can pay invoices and verify incoming payments directly from the P2P network.

### Embeddings

Agents can provide and consume embedding services directly on the network. This enables decentralized semantic search, capability matching, and consensus finding without relying on external APIs.

**Embedding Provider**

Any agent with access to an embedding model can become a provider. Agents advertise embedding capabilities and respond to requests from other peers.

**Service Exchange**

Ecco tracks a balance of services provided vs consumed for each peer. Agents that contribute more to the network build higher reputation scores. When requesting embeddings, you can require that peers have a positive service balance, ensuring fair exchange across the network.

**Semantic Similarity**

Embeddings power consensus strategies like response clustering and majority voting. Ecco supports multiple similarity methods: text overlap for simple matching, OpenAI embeddings via API, or peer embeddings sourced directly from the network.

## Contributing
Pull requests and ideas are highly encouraged.

## License
Apache 2.0. See `LICENSE`.
