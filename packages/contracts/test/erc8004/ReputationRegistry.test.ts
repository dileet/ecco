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
      85n,
      0,
      "quality",
      "speed",
      "https://api.example.com",
      "ipfs://feedback",
      feedbackHash,
    ], { account: client1.account });

    const [value, valueDecimals, tag1, tag2, revoked] = await reputationRegistry.read.readFeedback([
      agentId,
      client1.account.address,
      1n,
    ]);

    expect(value).to.equal(85n);
    expect(valueDecimals).to.equal(0);
    expect(tag1).to.equal("quality");
    expect(tag2).to.equal("speed");
    expect(revoked).to.equal(false);
  });

  it("rejects feedback from token-approved operators", async () => {
    const { reputationRegistry, identityRegistry, agentId, owner, client1 } = await deployReputationFixture();

    await identityRegistry.write.approve([client1.account.address, agentId], { account: owner.account });

    try {
      await reputationRegistry.write.giveFeedback([
        agentId,
        85n,
        0,
        "quality",
        "speed",
        "https://api.example.com",
        "ipfs://feedback",
        keccak256(stringToBytes("feedback-1")),
      ], { account: client1.account });
      expect.fail("Expected feedback to revert for token-approved operator");
    } catch (error) {
      expect(String(error)).to.match(/Owner or approved cannot give feedback/);
    }
  });

  it("rejects feedback from operator-for-all", async () => {
    const { reputationRegistry, identityRegistry, agentId, owner, client1 } = await deployReputationFixture();

    await identityRegistry.write.setApprovalForAll([client1.account.address, true], { account: owner.account });

    try {
      await reputationRegistry.write.giveFeedback([
        agentId,
        85n,
        0,
        "quality",
        "speed",
        "https://api.example.com",
        "ipfs://feedback",
        keccak256(stringToBytes("feedback-1")),
      ], { account: client1.account });
      expect.fail("Expected feedback to revert for operator-for-all");
    } catch (error) {
      expect(String(error)).to.match(/Owner or approved cannot give feedback/);
    }
  });

  it("allows non-owner to append response and emits response hash", async () => {
    const { reputationRegistry, agentId, client1, client2 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      80n,
      0,
      "quality",
      "speed",
      "https://api.example.com",
      "ipfs://feedback",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    const responseHash = keccak256(stringToBytes("response-1"));
    await reputationRegistry.write.appendResponse([
      agentId,
      client1.account.address,
      1n,
      "ipfs://response",
      responseHash,
    ], { account: client2.account });

    const events = await reputationRegistry.getEvents.ResponseAppended();
    expect(events.length).to.be.greaterThan(0);
    const event = events[events.length - 1];
    expect(event.args.agentId).to.equal(agentId);
    expect(event.args.clientAddress.toLowerCase()).to.equal(client1.account.address.toLowerCase());
    expect(event.args.feedbackIndex).to.equal(1n);
    expect(event.args.responder.toLowerCase()).to.equal(client2.account.address.toLowerCase());
    expect(event.args.responseURI).to.equal("ipfs://response");
    expect(event.args.responseHash).to.equal(responseHash);
  });

  it("filters readAllFeedback by tag and returns parallel arrays", async () => {
    const { reputationRegistry, agentId, client1, client2 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      90n,
      0,
      "accuracy",
      "speed",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.giveFeedback([
      agentId,
      70n,
      0,
      "quality",
      "tone",
      "https://endpoint-2",
      "ipfs://feedback-2",
      keccak256(stringToBytes("feedback-2")),
    ], { account: client2.account });

    const [clients, indexes, values, valueDecimalsArr, tag1s, tag2s, revoked] = await reputationRegistry.read.readAllFeedback([
      agentId,
      [],
      "accuracy",
      "",
      false,
    ]);

    expect(clients.length).to.equal(1);
    expect(indexes.length).to.equal(1);
    expect(values.length).to.equal(1);
    expect(values[0]).to.equal(90n);
    expect(valueDecimalsArr[0]).to.equal(0);
    expect(tag1s[0]).to.equal("accuracy");
    expect(tag2s[0]).to.equal("speed");
    expect(revoked[0]).to.equal(false);
  });

  it("revokes feedback and excludes it when includeRevoked is false", async () => {
    const { reputationRegistry, agentId, client1 } = await deployReputationFixture();

    await reputationRegistry.write.giveFeedback([
      agentId,
      60n,
      0,
      "quality",
      "tone",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client1.account });

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
      50n,
      0,
      "quality",
      "tone",
      "https://endpoint-1",
      "ipfs://feedback-1",
      keccak256(stringToBytes("feedback-1")),
    ], { account: client1.account });

    await reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client1.account });

    const [clients, indexes, , , , , revoked] = await reputationRegistry.read.readAllFeedback([
      agentId,
      [],
      "",
      "",
      true,
    ]);

    expect(clients.length).to.equal(1);
    expect(indexes[0]).to.equal(1n);
    expect(revoked[0]).to.equal(true);
  });
});
