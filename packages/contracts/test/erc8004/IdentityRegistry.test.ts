import { describe, it } from "node:test";
import { expect } from "chai";
import { keccak256, stringToBytes, hexToBytes, hashTypedData } from "viem";
import hre from "hardhat";
import { deployAgentIdentityRegistryFixture, getNetworkHelpers } from "../helpers/fixtures";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("ERC-8004 Identity Registry", () => {
  it("registers with URI and emits Registered event", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });

    const events = await identityRegistry.getEvents.Registered();
    const event = events[events.length - 1];

    expect(event.args.agentURI).to.equal("ipfs://agent-uri");
    const owner = event.args.owner ?? user1.account.address;
    expect(owner.toLowerCase()).to.equal(user1.account.address.toLowerCase());

    const agentId = event.args.agentId!;
    const uri = await identityRegistry.read.agentURI([agentId]);
    expect(uri).to.equal("ipfs://agent-uri");
  });

  it("registers with metadata and blocks reserved agentWallet key", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    const metadata = [
      { metadataKey: "peerIdHash", metadataValue: keccak256(stringToBytes("peer-1")) },
    ];

    await identityRegistry.write.register(["ipfs://agent-uri", metadata], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const peerIdHash = await identityRegistry.read.getMetadata([agentId, "peerIdHash"]);
    expect(peerIdHash).to.equal(metadata[0].metadataValue);

    try {
      await identityRegistry.write.setMetadata([agentId, "agentWallet", "0x1234" as `0x${string}`], { account: user1.account });
      expect.fail("Expected setMetadata to revert for reserved key");
    } catch (error) {
      expect(String(error)).to.match(/Reserved key/);
    }
  });

  it("sets agent wallet via signature and resets on transfer", async () => {
    const { identityRegistry, user1, user2, publicClient: testClient } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const chainId = await testClient.getChainId();
    const domain = {
      name: "AgentIdentityRegistry",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: identityRegistry.address,
    };
    const types = {
      AgentWallet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      agentId,
      newWallet: user2.account.address,
      deadline,
    };

    const signature = await user1.signTypedData({ domain, types, primaryType: "AgentWallet", message });

    await identityRegistry.write.setAgentWallet([agentId, user2.account.address, deadline, signature], { account: user1.account });
    const agentWallet = await identityRegistry.read.getMetadata([agentId, "agentWallet"]);
    expect(agentWallet).to.equal(`0x${Buffer.from(hexToBytes(user2.account.address)).toString("hex")}` as `0x${string}`);

    await identityRegistry.write.transferFrom([user1.account.address, user2.account.address, agentId], { account: user1.account });
    const reset = await identityRegistry.read.getMetadata([agentId, "agentWallet"]);
    expect(reset).to.equal("0x0000000000000000000000000000000000000000");
  });

  it("returns global registry ID without agent id", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const globalId = await identityRegistry.read.getGlobalId([agentId]);
    expect(globalId).to.match(/^eip155:\d+:0x[a-fA-F0-9]{40}$/);
  });

  it("rejects setAgentWallet with invalid signature", async () => {
    const { identityRegistry, user1, user2 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = "0x1234" as `0x${string}`;

    try {
      await identityRegistry.write.setAgentWallet([agentId, user2.account.address, deadline, signature], { account: user1.account });
      expect.fail("Expected invalid signature to revert");
    } catch (error) {
      expect(String(error)).to.match(/Invalid signature|ContractFunctionExecutionError/);
    }
  });

  it("accepts ERC1271 signatures for contract owners", async () => {
    const { viem } = await hre.network.connect();
    const [owner] = await viem.getWalletClients();

    const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
    const walletMock = await viem.deployContract("ERC1271WalletMock", []);
    const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
      eccoToken.address,
      owner.account.address,
    ]);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: owner.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    await identityRegistry.write.transferFrom([owner.account.address, walletMock.address, agentId], { account: owner.account });

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const chainId = await (await viem.getPublicClient()).getChainId();
    const domain = {
      name: "AgentIdentityRegistry",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: identityRegistry.address,
    };
    const types = {
      AgentWallet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      agentId,
      newWallet: owner.account.address,
      deadline,
    };

    const digest = hashTypedData({ domain, types, primaryType: "AgentWallet", message });
    const placeholderSignature = "0x" as `0x${string}`;

    await walletMock.write.setValidHash([digest]);

    await identityRegistry.write.setAgentWallet([
      agentId,
      owner.account.address,
      deadline,
      placeholderSignature,
    ], { account: owner.account });

    const agentWallet = await identityRegistry.read.getMetadata([agentId, "agentWallet"]);
    expect(agentWallet).to.equal(`0x${Buffer.from(hexToBytes(owner.account.address)).toString("hex")}` as `0x${string}`);
  });

  it("binds peer ID in single transaction", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const peerId = "12D3KooWTestPeerId123456789";
    await identityRegistry.write.bindPeerId([agentId, peerId], { account: user1.account });

    const storedPeerId = await identityRegistry.read.getMetadata([agentId, "peerId"]);
    const decodedPeerId = new TextDecoder().decode(hexToBytes(storedPeerId));
    expect(decodedPeerId).to.equal(peerId);

    const peerIdHash = keccak256(stringToBytes(peerId));
    const storedPeerIdHash = await identityRegistry.read.getMetadata([agentId, "peerIdHash"]);
    expect(storedPeerIdHash).to.equal(peerIdHash);

    const agentIdFromHash = await identityRegistry.read.getAgentByPeerIdHash([peerIdHash]);
    expect(agentIdFromHash).to.equal(agentId);
  });

  it("prevents duplicate peer ID bindings", async () => {
    const { identityRegistry, user1, user2 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri-1"], { account: user1.account });
    const events1 = await identityRegistry.getEvents.Registered();
    const agentId1 = events1[events1.length - 1].args.agentId!;

    await identityRegistry.write.register(["ipfs://agent-uri-2"], { account: user2.account });
    const events2 = await identityRegistry.getEvents.Registered();
    const agentId2 = events2[events2.length - 1].args.agentId!;

    const peerId = "12D3KooWTestPeerId123456789";
    await identityRegistry.write.bindPeerId([agentId1, peerId], { account: user1.account });

    try {
      await identityRegistry.write.bindPeerId([agentId2, peerId], { account: user2.account });
      expect.fail("Expected bindPeerId to revert for duplicate peer ID");
    } catch (error) {
      expect(String(error)).to.match(/PeerId already bound/);
    }
  });

  it("allows rebinding peer ID to same agent", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const peerId = "12D3KooWTestPeerId123456789";
    await identityRegistry.write.bindPeerId([agentId, peerId], { account: user1.account });
    await identityRegistry.write.bindPeerId([agentId, peerId], { account: user1.account });

    const agentIdFromHash = await identityRegistry.read.getAgentByPeerIdHash([keccak256(stringToBytes(peerId))]);
    expect(agentIdFromHash).to.equal(agentId);
  });

  it("clears old peer ID hash when rebinding new peer ID", async () => {
    const { identityRegistry, user1 } = await loadFixtureWithHelpers(deployAgentIdentityRegistryFixture);

    await identityRegistry.write.register(["ipfs://agent-uri"], { account: user1.account });
    const events = await identityRegistry.getEvents.Registered();
    const agentId = events[events.length - 1].args.agentId!;

    const peerId1 = "12D3KooWTestPeerId1";
    const peerId2 = "12D3KooWTestPeerId2";

    await identityRegistry.write.bindPeerId([agentId, peerId1], { account: user1.account });
    await identityRegistry.write.bindPeerId([agentId, peerId2], { account: user1.account });

    const oldHash = keccak256(stringToBytes(peerId1));
    const newHash = keccak256(stringToBytes(peerId2));

    const agentIdFromOldHash = await identityRegistry.read.getAgentByPeerIdHash([oldHash]);
    expect(agentIdFromOldHash).to.equal(0n);

    const agentIdFromNewHash = await identityRegistry.read.getAgentByPeerIdHash([newHash]);
    expect(agentIdFromNewHash).to.equal(agentId);
  });
});
