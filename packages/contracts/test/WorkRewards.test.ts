import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, keccak256, stringToBytes } from "viem";
import { deployWorkRewardsFixture, getNetworkHelpers } from "./helpers/fixtures";
import { MIN_STAKE_TO_WORK, generateJobId, generatePeerId, REWARD_PER_EPOCH } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

type WorkRewardsFixture = Awaited<ReturnType<typeof deployWorkRewardsFixture>>;
type IdentityRegistry = WorkRewardsFixture["identityRegistry"];
type StakeRegistry = WorkRewardsFixture["stakeRegistry"];
type WalletClient = WorkRewardsFixture["user1"];

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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([workRewards.address, parseEther("10000")]);

      const rewardWithoutConsensus = await workRewards.read.calculateReward([user1.account.address, 1000n, false, false]);
      const rewardWithConsensus = await workRewards.read.calculateReward([user1.account.address, 1000n, true, false]);

      expect(rewardWithConsensus > rewardWithoutConsensus).to.equal(true);
    });

    it("should apply fast response bonus when fastResponse is true", async () => {
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

      const rewardWithoutFast = await workRewards.read.calculateReward([user1.account.address, 1000n, false, false]);
      const rewardWithFast = await workRewards.read.calculateReward([user1.account.address, 1000n, false, true]);

      expect(rewardWithFast > rewardWithoutFast).to.equal(true);
    });

    it("should apply all bonuses when both flags are true", async () => {
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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

  describe("Quality Multiplier Cap", () => {
    it("should have default maxQualityMultiplier of 300", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);
      expect(await workRewards.read.maxQualityMultiplier()).to.equal(300n);
    });

    it("should cap quality multiplier at maxQualityMultiplier", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.setRewardParameters([parseEther("1"), 200n, 200n, 200n]);

      const rewardCapped = await workRewards.read.calculateReward(["0x0000000000000000000000000000000000000001", 1000n, true, true]);
      const baseReward = await workRewards.read.getCurrentBaseReward();
      const expectedCapped = (baseReward * 1n * 300n) / 100n;
      expect(rewardCapped).to.equal(expectedCapped);
    });

    it("should allow owner to set maxQualityMultiplier", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.setMaxQualityMultiplier([400n]);
      expect(await workRewards.read.maxQualityMultiplier()).to.equal(400n);
    });

    it("should reject maxQualityMultiplier below 100", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setMaxQualityMultiplier([99n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Max quality multiplier must be at least 100/);
      }
    });

    it("should reject maxQualityMultiplier above 1000", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setMaxQualityMultiplier([1001n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Max quality multiplier exceeds 1000%/);
      }
    });

    it("should reject non-owner from setting maxQualityMultiplier", async () => {
      const { workRewards, user1 } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setMaxQualityMultiplier([400n], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, user2, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId1 = generatePeerId(user1.account.address);
      const peerId2 = generatePeerId(user2.account.address);
      const agentId1 = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId1);
      const agentId2 = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user2, peerId2);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId1, MIN_STAKE_TO_WORK], { account: user1.account });

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user2.account });
      await stakeRegistry.write.stake([agentId2, MIN_STAKE_TO_WORK], { account: user2.account });

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
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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

  describe("Reward Parameter Validation", () => {
    it("should accept valid reward parameters", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.setRewardParameters([parseEther("2"), 100n, 50n, 25n]);

      expect(await workRewards.read.baseRewardPerJob()).to.equal(parseEther("2"));
      expect(await workRewards.read.consensusBonus()).to.equal(100n);
      expect(await workRewards.read.fastResponseBonus()).to.equal(50n);
      expect(await workRewards.read.stakerBonus()).to.equal(25n);
    });

    it("should reject zero base reward", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setRewardParameters([0n, 50n, 25n, 10n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Base reward must be positive/);
      }
    });

    it("should reject base reward exceeding maximum", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setRewardParameters([parseEther("1001"), 50n, 25n, 10n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Base reward too high/);
      }
    });

    it("should reject consensus bonus exceeding 200%", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setRewardParameters([parseEther("1"), 201n, 25n, 10n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Consensus bonus exceeds 200%/);
      }
    });

    it("should reject fast response bonus exceeding 200%", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setRewardParameters([parseEther("1"), 50n, 201n, 10n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Fast response bonus exceeds 200%/);
      }
    });

    it("should reject staker bonus exceeding 200%", async () => {
      const { workRewards } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      try {
        await workRewards.write.setRewardParameters([parseEther("1"), 50n, 25n, 201n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Staker bonus exceeds 200%/);
      }
    });
  });

  describe("Reward Pool", () => {
    it("should cap reward at available balance", async () => {
      const { workRewards, identityRegistry, stakeRegistry, eccoToken, user1, distributor } = await loadFixtureWithHelpers(deployWorkRewardsFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      const peerId = generatePeerId(user1.account.address);
      const agentId = await registerAgentWithPeerId(identityRegistry, stakeRegistry, user1, peerId);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([stakeRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await stakeRegistry.write.stake([agentId, MIN_STAKE_TO_WORK], { account: user1.account });

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
