import { describe, it } from "node:test";
import { expect } from "chai";
import { keccak256, stringToBytes } from "viem";
import hre from "hardhat";

async function deployValidationFixture() {
  const { viem } = await hre.network.connect();
  const [owner, validator, requester] = await viem.getWalletClients();

  const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
  const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
    eccoToken.address,
    owner.account.address,
  ]);
  const validationRegistry = await viem.deployContract("AgentValidationRegistry", [
    identityRegistry.address,
  ]);

  await identityRegistry.write.register(["ipfs://agent-uri"], { account: owner.account });
  const events = await identityRegistry.getEvents.Registered();
  const agentId = events[events.length - 1].args.agentId!;

  return { validationRegistry, identityRegistry, agentId, owner, validator, requester };
}

describe("ERC-8004 Validation Registry", () => {
  it("records validation request and response via requestHash", async () => {
    const { validationRegistry, agentId, owner, validator } = await deployValidationFixture();

    const requestHash = keccak256(stringToBytes("request-1"));
    await validationRegistry.write.validationRequest([
      validator.account.address,
      agentId,
      "ipfs://request",
      requestHash,
    ], { account: owner.account });

    const request = await validationRegistry.read.getValidationRequest([requestHash]);
    expect(request.validator.toLowerCase()).to.equal(validator.account.address.toLowerCase());
    expect(request.agentId).to.equal(agentId);

    await validationRegistry.write.validationResponse([
      requestHash,
      90,
      "ipfs://response",
      keccak256(stringToBytes("response-1")),
      "quality",
    ], { account: validator.account });

    const status = await validationRegistry.read.getValidationStatus([requestHash]);
    expect(status[2]).to.equal(90);
    expect(status[3]).to.equal("quality");
  });

  it("allows multiple responses per request hash", async () => {
    const { validationRegistry, agentId, owner, validator } = await deployValidationFixture();

    const requestHash = keccak256(stringToBytes("request-2"));
    await validationRegistry.write.validationRequest([
      validator.account.address,
      agentId,
      "ipfs://request",
      requestHash,
    ], { account: owner.account });

    await validationRegistry.write.validationResponse([
      requestHash,
      70,
      "ipfs://response-1",
      keccak256(stringToBytes("response-1")),
      "speed",
    ], { account: validator.account });

    await validationRegistry.write.validationResponse([
      requestHash,
      95,
      "ipfs://response-2",
      keccak256(stringToBytes("response-2")),
      "quality",
    ], { account: validator.account });

    const status = await validationRegistry.read.getValidationStatus([requestHash]);
    expect(status[2]).to.equal(95);
    expect(status[3]).to.equal("quality");
  });

  it("rejects response from non-validator", async () => {
    const { validationRegistry, agentId, owner, validator, requester } = await deployValidationFixture();

    const requestHash = keccak256(stringToBytes("request-3"));
    await validationRegistry.write.validationRequest([
      validator.account.address,
      agentId,
      "ipfs://request",
      requestHash,
    ], { account: owner.account });

    try {
      await validationRegistry.write.validationResponse([
        requestHash,
        40,
        "ipfs://response",
        keccak256(stringToBytes("response-3")),
        "quality",
      ], { account: requester.account });
      expect.fail("Expected response to revert for non-validator");
    } catch (error) {
      expect(String(error)).to.match(/Not the designated validator/);
    }
  });
});
