import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther } from "viem";
import { deployFeeCollectorFixture, getNetworkHelpers } from "./helpers/fixtures";
import { FEE_PERCENT, TREASURY_SHARE, BURN_SHARE, STAKER_SHARE, MIN_STAKE_TO_WORK, generatePeerId } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
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
      const { feeCollector, reputationRegistry, eccoToken, treasury, user1, user2 } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

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

    it("should reject shares not summing to 100", async () => {
      const { feeCollector } = await loadFixtureWithHelpers(deployFeeCollectorFixture);

      try {
        await feeCollector.write.setDistributionShares([40n, 40n, 30n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Shares must sum to 100/);
      }
    });
  });
});
