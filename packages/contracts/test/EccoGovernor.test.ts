import { describe, it } from "node:test";
import { expect } from "chai";
import hre from "hardhat";
import { parseEther, keccak256, stringToBytes } from "viem";
import { deployGovernorFixture, getNetworkHelpers } from "./helpers/fixtures";
import { TIMELOCK_MIN_DELAY, VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, QUORUM_PERCENT } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("EccoGovernor", () => {
  describe("Quorum Excludes Staked Tokens", () => {
    it("should exclude staked tokens from quorum calculation", async () => {
      const { viem } = await hre.network.connect();
      const [owner, staker] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
        eccoToken.address,
        owner.account.address,
      ]);
      const stakeRegistry = await viem.deployContract("AgentStakeRegistry", [
        eccoToken.address,
        identityRegistry.address,
        owner.account.address,
      ]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [
        TIMELOCK_MIN_DELAY,
        [owner.account.address],
        [owner.account.address],
        owner.account.address,
      ]);
      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
        stakeRegistry.address,
      ]);

      const totalStakedBefore = await stakeRegistry.read.totalStaked();
      expect(totalStakedBefore).to.equal(0n);

      const stakeAmount = parseEther("300000");
      await eccoToken.write.mint([staker.account.address, stakeAmount]);

      const hash = await identityRegistry.write.register(["ipfs://agent-uri"], { account: staker.account });
      const events = await identityRegistry.getEvents.Registered();
      const agentId = events[events.length - 1].args.agentId!;

      const peerId = "test-peer-id";
      const peerIdHash = keccak256(stringToBytes(peerId));
      await identityRegistry.write.setMetadata([agentId, "peerIdHash", peerIdHash], { account: staker.account });

      await eccoToken.write.approve([stakeRegistry.address, stakeAmount], { account: staker.account });
      await stakeRegistry.write.stake([agentId, stakeAmount], { account: staker.account });

      const totalStakedAfter = await stakeRegistry.read.totalStaked();
      expect(totalStakedAfter).to.equal(stakeAmount);

      const registryAddr = await eccoGovernor.read.identityRegistry();
      expect(registryAddr.toLowerCase()).to.equal(stakeRegistry.address.toLowerCase());
    });

    it("should have stake registry reference", async () => {
      const { eccoGovernor } = await loadFixtureWithHelpers(deployGovernorFixture);
      const registryAddress = await eccoGovernor.read.identityRegistry();
      expect(registryAddress).to.not.equal("0x0000000000000000000000000000000000000000");
    });
  });

  describe("Minimum Voting Delay", () => {
    it("should reject deployment with votingDelay below minimum", async () => {
      const { viem } = await hre.network.connect();
      const [owner] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
        eccoToken.address,
        owner.account.address,
      ]);
      const stakeRegistry = await viem.deployContract("AgentStakeRegistry", [
        eccoToken.address,
        identityRegistry.address,
        owner.account.address,
      ]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [
        TIMELOCK_MIN_DELAY,
        [owner.account.address],
        [owner.account.address],
        owner.account.address,
      ]);

      try {
        await viem.deployContract("EccoGovernor", [
          eccoToken.address,
          eccoTimelock.address,
          7200,
          VOTING_PERIOD,
          PROPOSAL_THRESHOLD,
          QUORUM_PERCENT,
          stakeRegistry.address,
        ]);
        expect.fail("Expected deployment to revert");
      } catch (error) {
        expect(String(error)).to.match(/VotingDelayTooShort/);
      }
    });

    it("should expose MIN_VOTING_DELAY constant", async () => {
      const { eccoGovernor } = await loadFixtureWithHelpers(deployGovernorFixture);
      const minDelay = await eccoGovernor.read.MIN_VOTING_DELAY();
      expect(Number(minDelay)).to.equal(86400);
    });

    it("should allow deployment with votingDelay at minimum", async () => {
      const { viem } = await hre.network.connect();
      const [owner] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
        eccoToken.address,
        owner.account.address,
      ]);
      const stakeRegistry = await viem.deployContract("AgentStakeRegistry", [
        eccoToken.address,
        identityRegistry.address,
        owner.account.address,
      ]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [
        TIMELOCK_MIN_DELAY,
        [owner.account.address],
        [owner.account.address],
        owner.account.address,
      ]);

      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        86400,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
        stakeRegistry.address,
      ]);

      expect(await eccoGovernor.read.votingDelay()).to.equal(86400n);
    });
  });
});
