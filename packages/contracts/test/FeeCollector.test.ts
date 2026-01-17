import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, keccak256, stringToBytes, toHex } from "viem";
import { deployFeeCollectorFixture, getNetworkHelpers } from "./helpers/fixtures";
import { FEE_PERCENT, TREASURY_SHARE, BURN_SHARE, STAKER_SHARE, MIN_STAKE_TO_WORK, generatePeerId } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

type FeeCollectorFixture = Awaited<ReturnType<typeof deployFeeCollectorFixture>>;
type IdentityRegistry = FeeCollectorFixture["identityRegistry"];
type StakeRegistry = FeeCollectorFixture["stakeRegistry"];
type WalletClient = FeeCollectorFixture["user1"];

function getPeerIdHash(peerId: string): `0x${string}` {
  return keccak256(stringToBytes(peerId));
}

async function registerAgentWithPeerId(
  identityRegistry: IdentityRegistry,
  stakeRegistry: StakeRegistry,
  user: WalletClient,
  peerId: string
): Promise<bigint> {
  const peerIdHash = getPeerIdHash(peerId);
  const hash = await identityRegistry.write.register(["ipfs://agent-uri"], { account: user.account });
  const events = await identityRegistry.getEvents.Registered();
  const agentId = events[events.length - 1].args.agentId!;
  await identityRegistry.write.setMetadata([agentId, "peerIdHash", peerIdHash], { account: user.account });
  return agentId;
}

describe("FeeCollector", () => {
  describe("Deployment", () => {
    it("should have correct feePercent", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);
      expect(await feeCollector.read.feePercent()).to.equal(FEE_PERCENT);
    });

    it("should have correct distribution shares", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);
      expect(await feeCollector.read.treasuryShare()).to.equal(TREASURY_SHARE);
      expect(await feeCollector.read.burnShare()).to.equal(BURN_SHARE);
      expect(await feeCollector.read.stakerShare()).to.equal(STAKER_SHARE);
    });
  });

  describe("Fee Collection", () => {
    it("should calculate fee correctly", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const amount = parseEther("1000");
      const expectedFee = (amount * FEE_PERCENT) / 10000n;

      expect(await feeCollector.read.calculateFee([amount])).to.equal(expectedFee);
    });

    it("should collect fee from payer", async () => {
      const { feeCollector, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const amount = parseEther("1000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([user1.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user1.account });

      await feeCollector.write.collectFee(
        [user1.account.address, user2.account.address, amount],
        { account: user1.account }
      );

      expect(await eccoToken.read.balanceOf([feeCollector.address])).to.equal(fee);
    });
  });

  describe("Fee Distribution", () => {
    it("should distribute fees correctly", async () => {
      const { feeCollector, identityRegistry, stakeRegistry, eccoToken, treasury, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

      const amount = parseEther("10000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([user2.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user2.account });
      await feeCollector.write.collectFee([user2.account.address, user1.account.address, amount], { account: user2.account });

      const treasuryBalanceBefore = await eccoToken.read.balanceOf([treasury.account.address]);
      const supplyBefore = await eccoToken.read.totalSupply();

      await feeCollector.write.distributeFees();

      const treasuryBalanceAfter = await eccoToken.read.balanceOf([treasury.account.address]);
      const supplyAfter = await eccoToken.read.totalSupply();

      expect(treasuryBalanceAfter > treasuryBalanceBefore).to.equal(true);
      expect(supplyAfter < supplyBefore).to.equal(true);
    });
  });

  describe("Admin Functions", () => {
    it("should reject fee > 10%", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.setFeePercent([1001n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Fee too high/);
      }
    });

    it("should allow fee at exactly 10%", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      await feeCollector.write.setFeePercent([1000n]);
      expect(await feeCollector.read.feePercent()).to.equal(1000n);
    });

    it("should reject shares not summing to 100", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.setDistributionShares([40n, 40n, 30n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Shares must sum to 100/);
      }
    });

    it("should allow valid distribution share changes", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      await feeCollector.write.setDistributionShares([40n, 40n, 20n]);
      expect(await feeCollector.read.stakerShare()).to.equal(40n);
      expect(await feeCollector.read.treasuryShare()).to.equal(40n);
      expect(await feeCollector.read.burnShare()).to.equal(20n);
    });

    it("should allow treasury address change", async () => {
      const { feeCollector, user1 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      await feeCollector.write.setTreasury([user1.account.address]);
      expect((await feeCollector.read.treasury()).toLowerCase()).to.equal(user1.account.address.toLowerCase());
    });

    it("should reject zero address for treasury", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.setTreasury(["0x0000000000000000000000000000000000000000"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Treasury cannot be zero address/);
      }
    });
  });

  describe("Zero Stakers Edge Case", () => {
    it("should handle distribution with no stakers", async () => {
      const { feeCollector, eccoToken, treasury, user1 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const amount = parseEther("10000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([user1.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user1.account });
      await feeCollector.write.collectFee([user1.account.address, treasury.account.address, amount], { account: user1.account });

      const treasuryBalanceBefore = await eccoToken.read.balanceOf([treasury.account.address]);

      await feeCollector.write.distributeFees();

      const treasuryBalanceAfter = await eccoToken.read.balanceOf([treasury.account.address]);
      expect(treasuryBalanceAfter > treasuryBalanceBefore).to.equal(true);
    });
  });

  describe("Staker Rewards", () => {
    it("should calculate pending rewards correctly", async () => {
      const { feeCollector, identityRegistry, stakeRegistry, eccoToken, treasury, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

      const amount = parseEther("10000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([user2.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user2.account });
      await feeCollector.write.collectFee([user2.account.address, user1.account.address, amount], { account: user2.account });

      await feeCollector.write.distributeFees();

      const pending = await feeCollector.read.pendingRewards([user1.account.address]);
      expect(pending > 0n).to.equal(true);
    });

    it("should allow stakers to claim rewards", async () => {
      const { feeCollector, identityRegistry, stakeRegistry, eccoToken, treasury, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

      const amount = parseEther("10000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([user2.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user2.account });
      await feeCollector.write.collectFee([user2.account.address, user1.account.address, amount], { account: user2.account });

      await feeCollector.write.distributeFees();

      const pendingBefore = await feeCollector.read.pendingRewards([user1.account.address]);
      expect(pendingBefore > 0n).to.equal(true);

      const balanceBefore = await eccoToken.read.balanceOf([user1.account.address]);
      await feeCollector.write.claimRewards({ account: user1.account });
      const balanceAfter = await eccoToken.read.balanceOf([user1.account.address]);

      expect(balanceAfter > balanceBefore).to.equal(true);

      const pendingAfter = await feeCollector.read.pendingRewards([user1.account.address]);
      expect(pendingAfter).to.equal(0n);
    });

    it("should distribute rewards proportionally to multiple stakers", async () => {
      const { feeCollector, identityRegistry, stakeRegistry, eccoToken, treasury, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      const peerId1 = generatePeerId(user1.account.address);
      const agentId1 = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId1);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId1, MIN_STAKE_TO_WORK], { account: user1.account });

      const peerId2 = generatePeerId(user2.account.address);
      const agentId2 = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user2, peerId2);

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_WORK * 2n]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK * 2n], { account: user2.account });
      await stakeRegistry.write.stake([agentId2, MIN_STAKE_TO_WORK * 2n], { account: user2.account });

      const amount = parseEther("10000");
      const fee = (amount * FEE_PERCENT) / 10000n;

      await eccoToken.write.mint([treasury.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: treasury.account });
      await feeCollector.write.collectFee([treasury.account.address, user1.account.address, amount], { account: treasury.account });

      await feeCollector.write.distributeFees();

      const pending1 = await feeCollector.read.pendingRewards([user1.account.address]);
      const pending2 = await feeCollector.read.pendingRewards([user2.account.address]);

      expect(pending2 > pending1).to.equal(true);
    });
  });

  describe("Distribution Edge Cases", () => {
    it("should reject distribution with zero balance", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.distributeFees();
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/No fees to distribute/);
      }
    });
  });

  describe("updateRewardDebt Access Control", () => {
    it("should reject updateRewardDebt calls from non-ReputationRegistry", async () => {
      const { feeCollector, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.updateRewardDebt([user2.account.address], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Only ReputationRegistry/);
      }
    });

    it("should reject updateRewardDebt even from owner", async () => {
      const { feeCollector, owner, user1 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.updateRewardDebt([user1.account.address], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Only ReputationRegistry/);
      }
    });
  });
});
