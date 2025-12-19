import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther } from "viem";
import { deployFullEcosystemFixture, getNetworkHelpers } from "../helpers/fixtures";
import { MIN_STAKE_TO_WORK, MIN_STAKE_TO_RATE, generatePeerId, generateJobId, generatePaymentId } from "../helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("Work Rewards Ecosystem Integration", () => {
  describe("Complete Work Cycle", () => {
    it("should complete stake -> work -> reward -> payment -> rate flow", async () => {
      const { eccoToken, reputationRegistry, workRewards, user1, user2, distributor } = await loadFixtureWithHelpers(deployFullEcosystemFixture);

      await workRewards.write.addDistributor([distributor.account.address]);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user2.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE, generatePeerId(user2.account.address)], { account: user2.account });

      await eccoToken.write.mint([workRewards.address, parseEther("100000")]);

      expect(await reputationRegistry.read.canWork([user1.account.address])).to.equal(true);

      const jobId = generateJobId(1);
      const balanceBefore = await eccoToken.read.balanceOf([user1.account.address]);

      await workRewards.write.distributeReward(
        [jobId, user1.account.address, 2000n, true, true],
        { account: distributor.account }
      );

      const balanceAfter = await eccoToken.read.balanceOf([user1.account.address]);
      expect(balanceAfter > balanceBefore).to.equal(true);

      const paymentId = generatePaymentId(1);
      await reputationRegistry.write.recordPayment(
        [paymentId, user1.account.address, parseEther("100")],
        { account: user2.account }
      );

      const repBefore = await reputationRegistry.read.reputations([user1.account.address]);

      await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user2.account });

      const repAfter = await reputationRegistry.read.reputations([user1.account.address]);
      expect(repAfter[0] > repBefore[0]).to.equal(true);
      expect(repAfter[1]).to.equal(5n);
    });
  });

  describe("Fee Collection and Distribution", () => {
    it("should distribute fees proportionally to stakers", async () => {
      const { eccoToken, reputationRegistry, feeCollector, treasury, user1, user2, user3 } = await loadFixtureWithHelpers(deployFullEcosystemFixture);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK, generatePeerId(user1.account.address)], { account: user1.account });

      const paymentAmount = parseEther("100000");
      const feePercent = await feeCollector.read.feePercent();
      const fee = (paymentAmount * feePercent) / 10000n;

      await eccoToken.write.mint([user3.account.address, fee]);
      await eccoToken.write.approve([feeCollector.address, fee], { account: user3.account });
      await feeCollector.write.collectFee([user3.account.address, user1.account.address, paymentAmount], { account: user3.account });

      const treasuryBefore = await eccoToken.read.balanceOf([treasury.account.address]);
      const supplyBefore = await eccoToken.read.totalSupply();

      await feeCollector.write.distributeFees();

      const treasuryAfter = await eccoToken.read.balanceOf([treasury.account.address]);
      const supplyAfter = await eccoToken.read.totalSupply();

      expect(treasuryAfter > treasuryBefore).to.equal(true);
      expect(supplyAfter < supplyBefore).to.equal(true);
    });
  });
});
