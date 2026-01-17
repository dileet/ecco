import { describe, it } from "node:test";
import { expect } from "chai";
import { keccak256, stringToBytes } from "viem";
import hre from "hardhat";

async function deployReputationFixture() {
  const { viem } = await hre.network.connect();
  const [owner, client1, client2] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
  const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
    eccoToken.address,
    owner.account.address,
  ]);
  const reputationRegistry = await viem.deployContract("AgentReputationRegistry", [
    identityRegistry.address,
  ]);

  await identityRegistry.write.register(["ipfs://agent-uri"], { account: owner.account });
  const events = await identityRegistry.getEvents.Registered();
  const agentId = events[events.length - 1].args.agentId!;

  return {
    identityRegistry,
    reputationRegistry,
    agentId,
    owner,
    client1,
    client2,
    publicClient,
  };
}

describe("ERC-8004 Reputation Registry", () => {
  it("accepts feedback with string tags and reads it back", async () => {
    const { reputationRegistry, agentId, client1 } = await deployReputationFixture();

    const feedbackHash = keccak256(stringToBytes("feedback-1"));
    await reputationRegistry.write.giveFeedback([
      agentId,
      85,
      "quality",
      "speed",
      "https://api.example.com",
      "ipfs://feedback",
      feedbackHash,
    ], { account: client1.account });

    const [score, tag1, tag2, revoked] = await reputationRegistry.read.readFeedback([
      agentId,
      client1.account.address,
      0n,
    ]);

    expect(score).to.equal(85);
    expect(tag1).to.equal("quality");
    expect(tag2).to.equal("speed");
    expect(revoked).to.equal(false);
  });

  it("filters readAllFeedback by tag and returns parallel arrays", async () => {
    const { reputationRegistry, agentId, client1, client2 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      90,
      "accuracy",
      "speed",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.giveFeedback([
      agentId,
      70,
      "quality",
      "tone",
      "https://endpoint-2",
      "ipfs://feedback-2",
      keccak256(stringToBytes("feedback-2")),
    ], { account: client2.account });

    const [clients, indexes, scores, tag1s, tag2s, revoked] = await reputationRegistry.read.readAllFeedback([
      agentId,
      [],
      "accuracy",
      "",
      false,
    ]);

    expect(clients.length).to.equal(1);
    expect(indexes.length).to.equal(1);
    expect(scores.length).to.equal(1);
    expect(tag1s[0]).to.equal("accuracy");
    expect(tag2s[0]).to.equal("speed");
    expect(revoked[0]).to.equal(false);
  });

  it("revokes feedback and excludes it when includeRevoked is false", async () => {
    const { reputationRegistry, agentId, client1 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      60,
      "quality",
      "tone",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.revokeFeedback([agentId, 0n], { account: client1.account });

    const [clients] = await reputationRegistry.read.readAllFeedback([
      agentId,
      [],
      "",
      "",
      false,
    ]);

    expect(clients.length).to.equal(0);
  });

  it("includes revoked feedback when includeRevoked is true", async () => {
    const { reputationRegistry, agentId, client1 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      50,
      "quality",
      "tone",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.revokeFeedback([agentId, 0n], { account: client1.account });

    const [clients, indexes, , , , revoked] = await reputationRegistry.read.readAllFeedback([
      agentId,
      [],
      "",
      "",
      true,
    ]);

    expect(clients.length).to.equal(1);
    expect(indexes[0]).to.equal(0n);
    expect(revoked[0]).to.equal(true);
  });
});
