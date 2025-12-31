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

    it("should return false for canRate with insufficient stake", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      expect(await reputationRegistry.read.canRate([user1.account.address])).to.equal(false);
    });

    it("should return true for canRate with sufficient stake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      expect(await reputationRegistry.read.canRate([user1.account.address])).to.equal(true);
    });
  });

  describe("Peer ID Edge Cases", () => {
    it("should reject zero peer ID hash", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const zeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });

      try {
        await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, zeroHash], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid peerId hash/);
      }
    });

    it("should reject duplicate peer ID registration from different wallet", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId], { account: user1.account });

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user2.account });

      try {
        await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/PeerId already registered/);
      }
    });

    it("should reject peer ID mismatch on subsequent stake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId1 = generatePeerId(user1.account.address);
      const peerId2 = generatePeerId("different-peer");

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK * 2n]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK * 2n], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId1], { account: user1.account });

      try {
        await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId2], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/PeerId mismatch/);
      }
    });

    it("should allow additional stake with same peer ID", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK * 2n]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK * 2n], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, peerId], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[4]).to.equal(MIN_STAKE_TO_WORK * 2n);
    });
  });

  describe("Rating Edge Cases", () => {
    it("should reject rating delta greater than 5", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(10);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, 6], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid rating delta/);
      }
    });

    it("should reject rating delta less than -5", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(11);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, -6], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid rating delta/);
      }
    });

    it("should reject double rating same payment", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(12);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Already rated/);
      }
    });

    it("should reject recording duplicate payment", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(13);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Payment already recorded/);
      }
    });

    it("should reject rating when not payer", async () => {
      const { reputationRegistry, eccoToken, user1, user2, user3 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user2.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user2.account.address)], { account: user2.account });

      const paymentId = generatePaymentId(14);
      await reputationRegistry.write.recordPayment([paymentId, user3.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Only payer can rate/);
      }
    });

    it("should reject rating non-existent payment", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const nonExistentPaymentId = generatePaymentId(999);

      try {
        await reputationRegistry.write.rateAfterPayment([nonExistentPaymentId, 5], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Payment not found/);
      }
    });

    it("should reject rating with insufficient stake to rate", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const smallStake = parseEther("1");
      await eccoToken.write.mint([user1.account.address, smallStake]);
      await eccoToken.write.approve([reputationRegistry.address, smallStake], { account: user1.account });
      await reputationRegistry.write.stake([smallStake, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(15);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Insufficient stake to rate/);
      }
    });

    it("should correctly apply negative rating delta", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId = generatePaymentId(16);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.rateAfterPayment([paymentId, -3], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user2.account.address]);
      expect(reputation[2]).to.equal(3n);
    });
  });

  describe("Complete Unstake Flow", () => {
    it("should reject complete unstake without request", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.completeUnstake({ account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/No unstake request/);
      }
    });
  });

  describe("Batch Rating", () => {
    it("should allow batch rating with valid inputs", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId1 = generatePaymentId(20);
      const paymentId2 = generatePaymentId(21);
      const paymentId3 = generatePaymentId(22);

      await reputationRegistry.write.recordPayment([paymentId1, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.recordPayment([paymentId2, user2.account.address, parseEther("200")], { account: user1.account });
      await reputationRegistry.write.recordPayment([paymentId3, user2.account.address, parseEther("300")], { account: user1.account });

      await reputationRegistry.write.batchRate([[paymentId1, paymentId2, paymentId3], [5, 3, -2]], { account: user1.account });

      const payment1 = await reputationRegistry.read.payments([paymentId1]);
      const payment2 = await reputationRegistry.read.payments([paymentId2]);
      const payment3 = await reputationRegistry.read.payments([paymentId3]);

      expect(payment1[4]).to.equal(true);
      expect(payment2[4]).to.equal(true);
      expect(payment3[4]).to.equal(true);
    });

    it("should reject batch rating with mismatched array lengths", async () => {
      const { reputationRegistry, eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentId1 = generatePaymentId(23);
      const paymentId2 = generatePaymentId(24);

      await reputationRegistry.write.recordPayment([paymentId1, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.recordPayment([paymentId2, user2.account.address, parseEther("200")], { account: user1.account });

      try {
        await reputationRegistry.write.batchRate([[paymentId1, paymentId2], [5]], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Length mismatch/);
      }
    });
  });

  describe("Slashing", () => {
    it("should allow owner to slash peer stake and transfer to treasury", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      const treasuryBalanceBefore = await eccoToken.read.balanceOf([treasury]);
      await reputationRegistry.write.slash([user1.account.address, 30n, "Misbehavior"], { account: owner.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      const expectedRemaining = (stakeAmount * 70n) / 100n;
      expect(reputation[4]).to.equal(expectedRemaining);

      const treasuryBalanceAfter = await eccoToken.read.balanceOf([treasury]);
      const expectedSlashed = (stakeAmount * 30n) / 100n;
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedSlashed);
    });

    it("should reject slashing more than 30%", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 31n, "Invalid slash"], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid slash percentage/);
      }
    });

    it("should reject slashing from non-owner", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 30n, "Unauthorized"], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should reject slashing without treasury set", async () => {
      const { reputationRegistry, eccoToken, owner, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 30n, "No treasury"], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Treasury not set/);
      }
    });

    it("should reject slashing zero stake", async () => {
      const { reputationRegistry, owner, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const treasury = user2.account.address;
      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 30n, "No stake"], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/No stake to slash/);
      }
    });

    it("should reject slashing 0 percent", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount, peerId], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 0n, "Zero percent"], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid slash percentage/);
      }
    });
  });

  describe("View Function Calculations", () => {
    it("should calculate rating weight based on stake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE * 4n]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE * 4n], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE * 4n, generatePeerId(user1.account.address)], { account: user1.account });

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("100")]);
      expect(weight > 0n).to.equal(true);
    });

    it("should return minimum weight for stakers below threshold", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("100")]);
      expect(weight > 0n).to.equal(true);
    });
  });

  describe("Unstake Cooldown Configuration", () => {
    it("should reject setting cooldown below minimum", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const halfDay = 12n * 60n * 60n;

      try {
        await reputationRegistry.write.setUnstakeCooldown([halfDay], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Cooldown below minimum/);
      }
    });

    it("should reject setting cooldown to zero", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      try {
        await reputationRegistry.write.setUnstakeCooldown([0n], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Cooldown below minimum/);
      }
    });

    it("should allow setting cooldown at minimum (1 day)", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const oneDay = 24n * 60n * 60n;
      await reputationRegistry.write.setUnstakeCooldown([oneDay], { account: owner.account });

      const cooldown = await reputationRegistry.read.unstakeCooldown();
      expect(cooldown).to.equal(oneDay);
    });

    it("should allow setting cooldown above minimum", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const fourteenDays = 14n * 24n * 60n * 60n;
      await reputationRegistry.write.setUnstakeCooldown([fourteenDays], { account: owner.account });

      const cooldown = await reputationRegistry.read.unstakeCooldown();
      expect(cooldown).to.equal(fourteenDays);
    });
  });

  describe("Min Stake Configuration", () => {
    it("should reject setting minStakeToRate to zero", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      try {
        await reputationRegistry.write.setMinStakes([MIN_STAKE_TO_WORK, 0n], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Min stake to rate must be positive/);
      }
    });

    it("should allow setting valid minStakeToRate", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const newMinStakeToRate = parseEther("20");
      await reputationRegistry.write.setMinStakes([MIN_STAKE_TO_WORK, newMinStakeToRate], { account: owner.account });

      const minStake = await reputationRegistry.read.minStakeToRate();
      expect(minStake).to.equal(newMinStakeToRate);
    });
  });

  describe("Rating Weight Edge Cases", () => {
    it("should return non-zero weight for staker at exact minimum stake", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("100")]);
      expect(weight > 0n).to.equal(true);
    });

    it("should ensure stakeWeight is at least 1 for any valid staker", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user1.account.address)], { account: user1.account });

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("1")]);
      expect(weight).to.equal(parseEther("1") / BigInt(1e18));
    });
  });
});
