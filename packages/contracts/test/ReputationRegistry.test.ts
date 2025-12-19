import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther } from "viem";
import { deployReputationRegistryFixture, getNetworkHelpers } from "./helpers/fixtures";
import { MIN_STAKE_TO_WORK, MIN_STAKE_TO_RATE, generatePeerId, generatePaymentId } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("ReputationRegistry", () => {
  describe("Deployment", () => {
    it("should set correct minStakeToWork", async () => {
      const { reputationRegistry } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      expect(await reputationRegistry.read.minStakeToWork()).to.equal(MIN_STAKE_TO_WORK);
    });

    it("should set correct minStakeToRate", async () => {
      const { reputationRegistry } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      expect(await reputationRegistry.read.minStakeToRate()).to.equal(MIN_STAKE_TO_RATE);
    });
  });

  describe("Staking", () => {
    it("should allow staking with valid peerId hash", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[4]).to.equal(stakeAmount);
    });

    it("should reject staking with zero amount", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);

      try {
        await reputationRegistry.write.stake([0n, peerId], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Must stake positive amount/);
      }
    });
  });

  describe("Unstaking", () => {
    it("should allow requesting unstake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      await reputationRegistry.write.requestUnstake([stakeAmount], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[5] > 0n).to.equal(true);
    });

    it("should reject unstake request for more than staked", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.requestUnstake([stakeAmount * 2n], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Insufficient stake/);
      }
    });

    it("should reject complete unstake before cooldown", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      await reputationRegistry.write.requestUnstake([stakeAmount], { account: user1.account });

      try {
        await reputationRegistry.write.completeUnstake({ account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Cooldown not complete/);
      }
    });
  });

  describe("Rating System", () => {
    it("should allow payer to rate after payment", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(1);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user1.account });

      const payment = await reputationRegistry.read.payments([paymentId]);
      expect(payment[4]).to.equal(true);
    });
  });

  describe("View Functions", () => {
    it("should return true for canWork with sufficient stake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

      expect(await reputationRegistry.read.canWork([user1.account.address])).to.equal(true);
    });

    it("should return false for canWork with insufficient stake", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      expect(await reputationRegistry.read.canWork([user1.account.address])).to.equal(false);
    });
  });
});
