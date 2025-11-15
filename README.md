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


## Contributing
Pull requests and ideas are highly encouraged.

## License
MIT. See `LICENSE`.

