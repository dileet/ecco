import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, keccak256, encodePacked, stringToBytes } from "viem";
import { deployWorkRewardsFixture, getNetworkHelpers, increaseTime } from "./helpers/fixtures";
import { MIN_STAKE_TO_WORK, generateJobId, generatePeerId, generateSalt, REWARD_PER_EPOCH, COMMIT_REVEAL_DELAY } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

type WorkRewardsFixture = Awaited<ReturnType<typeof deployWorkRewardsFixture>>;
type ReputationRegistry = WorkRewardsFixture["reputationRegistry"];
type WalletClient = WorkRewardsFixture["user1"];
type PublicClient = WorkRewardsFixture["publicClient"];

function getPeerIdHash(peerId: string): `0x${string}` {
  return keccak256(stringToBytes(peerId));
}

async function registerPeerIdWithCommitReveal(
  reputationRegistry: ReputationRegistry,
  publicClient: PublicClient,
  user: WalletClient,
  peerId: string,
  salt: `0x${string}`
) {
  const peerIdHash = getPeerIdHash(peerId);
  const commitHash = keccak256(encodePacked(["bytes32", "bytes32", "address"], [peerIdHash, salt, user.account.address]));
  await reputationRegistry.write.commitPeerId([commitHash], { account: user.account });
  await increaseTime(publicClient, COMMIT_REVEAL_DELAY + 10n);
  await reputationRegistry.write.revealPeerId([peerId, salt], { account: user.account });
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
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(200);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

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
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(201);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

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
    it("should return correct base reward for epoch 0", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.getCurrentBaseReward()).to.equal(REWARD_PER_EPOCH[0]);
    });

    it("should return baseRewardPerJob when halving is disabled", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.setHalvingEnabled([false]);
      expect(await workRewards.read.getCurrentBaseReward()).to.equal(parseEther("1"));
    });
  });

  describe("Access Control", () => {
    it("should reject reward from non-authorized distributor", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(202);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      try {
        await workRewards.write.distributeReward(
          [generateJobId(100), user1.account.address, 1000n, false, false],
          { account: user2.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Not authorized/);
      }
    });

    it("should reject reward for peer that cannot work", async () => {
      const { workRewards, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);
      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      try {
        await workRewards.write.distributeReward(
          [generateJobId(101), user1.account.address, 1000n, false, false],
          { account: distributor.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Peer cannot work/);
      }
    });
  });

  describe("Reward Bonuses", () => {
    it("should apply consensus bonus when consensusAchieved is true", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(203);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const rewardWithoutConsensus = await workRewards.read.calculateReward([user1.account.address, 1000n, false, false]);
      const rewardWithConsensus = await workRewards.read.calculateReward([user1.account.address, 1000n, true, false]);

      expect(rewardWithConsensus > rewardWithoutConsensus).to.equal(true);
    });

    it("should apply fast response bonus when fastResponse is true", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(204);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      const rewardWithoutFast = await workRewards.read.calculateReward([user1.account.address, 1000n, false, false]);
      const rewardWithFast = await workRewards.read.calculateReward([user1.account.address, 1000n, false, true]);

      expect(rewardWithFast > rewardWithoutFast).to.equal(true);
    });

    it("should apply all bonuses when both flags are true", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(205);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      const rewardNoBonuses = await workRewards.read.calculateReward([user1.account.address, 1000n, false, false]);
      const rewardAllBonuses = await workRewards.read.calculateReward([user1.account.address, 1000n, true, true]);

      expect(rewardAllBonuses > rewardNoBonuses).to.equal(true);
    });
  });

  describe("Difficulty Multiplier", () => {
    it("should cap difficulty at maxDifficultyMultiplier", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const rewardAtMax = await workRewards.read.calculateReward(["0x0000000000000000000000000000000000000001", 10000n, false, false]);
      const rewardOverMax = await workRewards.read.calculateReward(["0x0000000000000000000000000000000000000001", 100000n, false, false]);

      expect(rewardOverMax).to.equal(rewardAtMax);
    });

    it("should use minimum multiplier of 1 for low difficulty", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const rewardLowDifficulty = await workRewards.read.calculateReward(["0x0000000000000000000000000000000000000001", 100n, false, false]);
      expect(rewardLowDifficulty > 0n).to.equal(true);
    });
  });

  describe("Distributor Management", () => {
    it("should allow owner to remove distributor", async () => {
      const { workRewards, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);
      expect(await workRewards.read.isAuthorizedDistributor([distributor.account.address])).to.equal(true);

      await workRewards.write.removeDistributor([distributor.account.address]);
      expect(await workRewards.read.isAuthorizedDistributor([distributor.account.address])).to.equal(false);
    });

    it("should reject removing non-existent distributor", async () => {
      const { workRewards, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.removeDistributor([distributor.account.address]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Not authorized/);
      }
    });

    it("should reject adding duplicate distributor", async () => {
      const { workRewards, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      try {
        await workRewards.write.addDistributor([distributor.account.address]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Already authorized/);
      }
    });
  });

  describe("Batch Rewards", () => {
    it("should distribute batch rewards to multiple peers", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, user2, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId1 = generatePeerId(user1.account.address);
      const salt1 = generateSalt(206);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId1, salt1);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      const peerId2 = generatePeerId(user2.account.address);
      const salt2 = generateSalt(207);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user2, peerId2, salt2);

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user2.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user2.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const balanceBefore1 = await eccoToken.read.balanceOf([user1.account.address]);
      const balanceBefore2 = await eccoToken.read.balanceOf([user2.account.address]);

      const inputs = [
        { jobId: generateJobId(200), peer: user1.account.address, difficulty: 1000n, consensusAchieved: false, fastResponse: false },
        { jobId: generateJobId(201), peer: user2.account.address, difficulty: 1000n, consensusAchieved: true, fastResponse: false }
      ];

      await workRewards.write.distributeBatchRewards([inputs], { account: distributor.account });

      const balanceAfter1 = await eccoToken.read.balanceOf([user1.account.address]);
      const balanceAfter2 = await eccoToken.read.balanceOf([user2.account.address]);

      expect(balanceAfter1 > balanceBefore1).to.equal(true);
      expect(balanceAfter2 > balanceBefore2).to.equal(true);
    });

    it("should skip already rewarded jobs in batch", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(208);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const existingJobId = generateJobId(300);
      await workRewards.write.distributeReward(
        [existingJobId, user1.account.address, 1000n, false, false],
        { account: distributor.account }
      );

      const inputs = [
        { jobId: existingJobId, peer: user1.account.address, difficulty: 1000n, consensusAchieved: false, fastResponse: false },
        { jobId: generateJobId(301), peer: user1.account.address, difficulty: 1000n, consensusAchieved: false, fastResponse: false }
      ];

      const balanceBefore = await eccoToken.read.balanceOf([user1.account.address]);
      await workRewards.write.distributeBatchRewards([inputs], { account: distributor.account });
      const balanceAfter = await eccoToken.read.balanceOf([user1.account.address]);

      expect(balanceAfter > balanceBefore).to.equal(true);
    });
  });

  describe("Reward Pool", () => {
    it("should cap reward at available balance", async () => {
      const { workRewards, reputationRegistry, eccoToken, user1, distributor, publicClient } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(209);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("0.1")]);

      const balanceBefore = await eccoToken.read.balanceOf([user1.account.address]);
      await workRewards.write.distributeReward(
        [generateJobId(400), user1.account.address, 10000n, true, true],
        { account: distributor.account }
      );
      const balanceAfter = await eccoToken.read.balanceOf([user1.account.address]);

      expect(balanceAfter - balanceBefore).to.equal(parseEther("0.1"));
    });
  });
});
