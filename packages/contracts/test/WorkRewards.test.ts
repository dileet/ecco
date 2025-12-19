import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther } from "viem";
import { deployWorkRewardsFixture, getNetworkHelpers } from "./helpers/fixtures";
import { MIN_STAKE_TO_WORK, generateJobId, generatePeerId, REWARD_PER_EPOCH } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("WorkRewards", () => {
  describe("Deployment", () => {
    it("should have correct baseRewardPerJob", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.baseRewardPerJob()).to.equal(parseEther("1"));
    });

    it("should have correct consensusBonus", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.consensusBonus()).to.equal(50n);
    });
  });

  describe("Distributor Authorization", () => {
    it("should allow owner to add distributor", async () => {
      const { workRewards, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      expect(
        await workRewards.read.isAuthorizedDistributor([distributor.account.address])
      ).to.equal(true);
    });

    it("should reject adding distributor from non-owner", async () => {
      const { workRewards, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.addDistributor([distributor.account.address], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });
  });

  describe("Reward Distribution", () => {
    it("should distribute reward to peer", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const balanceBefore = await eccoToken.read.balanceOf([user1.account.address]);

      await workRewards.write.distributeReward(
        [generateJobId(1), user1.account.address, 1000n, false, false],
        { account: distributor.account }
      );

      const balanceAfter = await eccoToken.read.balanceOf([user1.account.address]);
      expect(balanceAfter > balanceBefore).to.equal(true);
    });

    it("should reject duplicate job ID", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const jobId = generateJobId(2);

      await workRewards.write.distributeReward(
        [jobId, user1.account.address, 1000n, false, false],
        { account: distributor.account }
      );

      try {
        await workRewards.write.distributeReward(
          [jobId, user1.account.address, 1000n, false, false],
          { account: distributor.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Job already rewarded/);
      }
    });
  });

  describe("Halving Schedule", () => {
    it("should return epoch 0 initially", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.getCurrentEpoch()).to.equal(0n);
    });

    it("should return correct base reward for epoch 0", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.getCurrentBaseReward()).to.equal(REWARD_PER_EPOCH[0]);
    });
  });
});
