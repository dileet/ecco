import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, keccak256, encodePacked, stringToBytes } from "viem";
import { deployReputationRegistryFixture, getNetworkHelpers, increaseTime } from "./helpers/fixtures";
import { MIN_STAKE_TO_WORK, MIN_STAKE_TO_RATE, generatePeerId, generatePaymentId, generateSalt, COMMIT_REVEAL_DELAY, MAX_BATCH_SIZE } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

type ReputationRegistry = Awaited<ReturnType<typeof deployReputationRegistryFixture>>["reputationRegistry"];
type WalletClient = Awaited<ReturnType<typeof deployReputationRegistryFixture>>["user1"];
type PublicClient = Awaited<ReturnType<typeof deployReputationRegistryFixture>>["publicClient"];

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

function getNamespacedPaymentId(payer: `0x${string}`, paymentId: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["address", "bytes32"], [payer, paymentId]));
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
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(1);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[4]).to.equal(stakeAmount);
    });

    it("should reject staking with zero amount", async () => {
      const { reputationRegistry, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(2);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      try {
        await reputationRegistry.write.stake([0n], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Must stake positive amount/);
      }
    });

    it("should reject staking without registered peerId", async () => {
      const { reputationRegistry, eccoToken, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });

      try {
        await reputationRegistry.write.stake([stakeAmount], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Must register peerId first/);
      }
    });
  });

  describe("Unstaking", () => {
    it("should allow requesting unstake", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(3);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

      await reputationRegistry.write.requestUnstake([stakeAmount], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[6] > 0n).to.equal(true);
    });

    it("should reject unstake request for more than staked", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(4);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

      try {
        await reputationRegistry.write.requestUnstake([stakeAmount * 2n], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Insufficient stake/);
      }
    });

    it("should reject complete unstake before cooldown", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(5);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(6);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const paymentId = generatePaymentId(1);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user1.account });

      const namespacedId = getNamespacedPaymentId(user1.account.address, paymentId);
      const payment = await reputationRegistry.read.payments([namespacedId]);
      expect(payment[4]).to.equal(true);
    });
  });

  describe("View Functions", () => {
    it("should return true for canWork with sufficient stake", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(7);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(8);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      expect(await reputationRegistry.read.canRate([user1.account.address])).to.equal(true);
    });
  });

  describe("Peer ID Commit-Reveal", () => {
    it("should reject zero commit hash", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const zeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

      try {
        await reputationRegistry.write.commitPeerId([zeroHash], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid commit hash/);
      }
    });

    it("should reject reveal before delay", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const peerIdHash = getPeerIdHash(peerId);
      const salt = generateSalt(9);
      const commitHash = keccak256(encodePacked(["bytes32", "bytes32", "address"], [peerIdHash, salt, user1.account.address]));

      await reputationRegistry.write.commitPeerId([commitHash], { account: user1.account });

      try {
        await reputationRegistry.write.revealPeerId([peerId, salt], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Reveal too early/);
      }
    });

    it("should reject invalid reveal (wrong salt)", async () => {
      const { reputationRegistry, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const peerIdHash = getPeerIdHash(peerId);
      const salt = generateSalt(10);
      const wrongSalt = generateSalt(999);
      const commitHash = keccak256(encodePacked(["bytes32", "bytes32", "address"], [peerIdHash, salt, user1.account.address]));

      await reputationRegistry.write.commitPeerId([commitHash], { account: user1.account });
      await increaseTime(publicClient, COMMIT_REVEAL_DELAY + 10n);

      try {
        await reputationRegistry.write.revealPeerId([peerId, wrongSalt], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid reveal/);
      }
    });

    it("should reject reveal without commitment", async () => {
      const { reputationRegistry, user1 } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(11);

      try {
        await reputationRegistry.write.revealPeerId([peerId, salt], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/No commitment found/);
      }
    });

    it("should reject duplicate peer ID registration from different wallet", async () => {
      const { reputationRegistry, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const peerIdHash = getPeerIdHash(peerId);
      const salt1 = generateSalt(12);
      const salt2 = generateSalt(13);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt1);

      const commitHash2 = keccak256(encodePacked(["bytes32", "bytes32", "address"], [peerIdHash, salt2, user2.account.address]));
      await reputationRegistry.write.commitPeerId([commitHash2], { account: user2.account });
      await increaseTime(publicClient, COMMIT_REVEAL_DELAY + 10n);

      try {
        await reputationRegistry.write.revealPeerId([peerId, salt2], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/PeerId already taken/);
      }
    });

    it("should allow additional stake after peerId registered", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(14);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_WORK * 2n]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_WORK * 2n], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_WORK], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user1.account.address]);
      expect(reputation[4]).to.equal(MIN_STAKE_TO_WORK * 2n);
    });

    it("should store full peerId string and allow lookup", async () => {
      const { reputationRegistry, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(40);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      const storedPeerId = await reputationRegistry.read.peerIdOf([user1.account.address]);
      expect(storedPeerId).to.equal(peerId);

      const wallet = await reputationRegistry.read.getWalletByPeerId([peerId]);
      expect(wallet.toLowerCase()).to.equal(user1.account.address.toLowerCase());
    });

    it("should reject empty peerId string", async () => {
      const { reputationRegistry, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);
      const emptyPeerId = "";
      const peerIdHash = getPeerIdHash("somePeerId");
      const salt = generateSalt(41);
      const commitHash = keccak256(encodePacked(["bytes32", "bytes32", "address"], [peerIdHash, salt, user1.account.address]));

      await reputationRegistry.write.commitPeerId([commitHash], { account: user1.account });
      await increaseTime(publicClient, COMMIT_REVEAL_DELAY + 10n);

      try {
        await reputationRegistry.write.revealPeerId([emptyPeerId, salt], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid peerId/);
      }
    });
  });

  describe("Rating Edge Cases", () => {
    it("should reject rating delta greater than 5", async () => {
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(15);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(16);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(17);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(18);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, user3, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId1 = generatePeerId(user1.account.address);
      const salt1 = generateSalt(19);
      const peerId2 = generatePeerId(user2.account.address);
      const salt2 = generateSalt(20);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId1, salt1);
      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user2, peerId2, salt2);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      await eccoToken.write.mint([user2.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user2.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user2.account });

      const paymentId = generatePaymentId(14);
      await reputationRegistry.write.recordPayment([paymentId, user3.account.address, parseEther("100")], { account: user1.account });

      try {
        await reputationRegistry.write.rateAfterPayment([paymentId, 5], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Payment not found/);
      }
    });

    it("should reject rating non-existent payment", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(21);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const nonExistentPaymentId = generatePaymentId(999);

      try {
        await reputationRegistry.write.rateAfterPayment([nonExistentPaymentId, 5], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Payment not found/);
      }
    });

    it("should reject rating with insufficient stake to rate", async () => {
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const smallStake = parseEther("1");
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(22);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, smallStake]);
      await eccoToken.write.approve([reputationRegistry.address, smallStake], { account: user1.account });
      await reputationRegistry.write.stake([smallStake], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(23);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const paymentId = generatePaymentId(16);
      await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.rateAfterPayment([paymentId, -3], { account: user1.account });

      const reputation = await reputationRegistry.read.reputations([user2.account.address]);
      expect(reputation[2]).to.equal(3n);
    });
  });

  describe("Complete Unstake Flow", () => {
    it("should reject complete unstake without request", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(24);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(25);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const paymentId1 = generatePaymentId(20);
      const paymentId2 = generatePaymentId(21);
      const paymentId3 = generatePaymentId(22);

      await reputationRegistry.write.recordPayment([paymentId1, user2.account.address, parseEther("100")], { account: user1.account });
      await reputationRegistry.write.recordPayment([paymentId2, user2.account.address, parseEther("200")], { account: user1.account });
      await reputationRegistry.write.recordPayment([paymentId3, user2.account.address, parseEther("300")], { account: user1.account });

      await reputationRegistry.write.batchRate([[paymentId1, paymentId2, paymentId3], [5, 3, -2]], { account: user1.account });

      const payment1 = await reputationRegistry.read.payments([getNamespacedPaymentId(user1.account.address, paymentId1)]);
      const payment2 = await reputationRegistry.read.payments([getNamespacedPaymentId(user1.account.address, paymentId2)]);
      const payment3 = await reputationRegistry.read.payments([getNamespacedPaymentId(user1.account.address, paymentId3)]);

      expect(payment1[4]).to.equal(true);
      expect(payment2[4]).to.equal(true);
      expect(payment3[4]).to.equal(true);
    });

    it("should reject batch rating with mismatched array lengths", async () => {
      const { reputationRegistry, eccoToken, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(26);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

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

    it("should reject batch rating exceeding MAX_BATCH_SIZE", async () => {
      const { reputationRegistry, eccoToken, user1, user2, owner, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(100);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      await reputationRegistry.write.setRateLimits([86400n, 100n], { account: owner.account });

      const batchSize = Number(MAX_BATCH_SIZE) + 1;
      const paymentIds: `0x${string}`[] = [];
      const deltas: number[] = [];

      for (let i = 0; i < batchSize; i++) {
        const paymentId = generatePaymentId(1000 + i);
        paymentIds.push(paymentId);
        deltas.push(1);
        await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("10")], { account: user1.account });
      }

      try {
        await reputationRegistry.write.batchRate([paymentIds, deltas], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Batch size exceeds limit/);
      }
    });

    it("should allow batch rating at exactly MAX_BATCH_SIZE", async () => {
      const { reputationRegistry, eccoToken, user1, user2, owner, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(101);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      await reputationRegistry.write.setRateLimits([86400n, 100n], { account: owner.account });

      const batchSize = Number(MAX_BATCH_SIZE);
      const paymentIds: `0x${string}`[] = [];
      const deltas: number[] = [];

      for (let i = 0; i < batchSize; i++) {
        const paymentId = generatePaymentId(2000 + i);
        paymentIds.push(paymentId);
        deltas.push(1);
        await reputationRegistry.write.recordPayment([paymentId, user2.account.address, parseEther("10")], { account: user1.account });
      }

      await reputationRegistry.write.batchRate([paymentIds, deltas], { account: user1.account });

      const firstPayment = await reputationRegistry.read.payments([getNamespacedPaymentId(user1.account.address, paymentIds[0])]);
      const lastPayment = await reputationRegistry.read.payments([getNamespacedPaymentId(user1.account.address, paymentIds[batchSize - 1])]);
      expect(firstPayment[4]).to.equal(true);
      expect(lastPayment[4]).to.equal(true);
    });
  });

  describe("Slashing", () => {
    it("should allow owner to slash peer stake and transfer to treasury", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(27);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

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
      const { reputationRegistry, eccoToken, owner, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(28);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 31n, "Invalid slash"], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid slash percentage/);
      }
    });

    it("should reject slashing from non-owner", async () => {
      const { reputationRegistry, eccoToken, owner, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(29);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

      try {
        await reputationRegistry.write.slash([user1.account.address, 30n, "Unauthorized"], { account: user2.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should reject slashing without treasury set", async () => {
      const { reputationRegistry, eccoToken, owner, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(30);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

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
      const { reputationRegistry, eccoToken, owner, user1, user2, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const stakeAmount = MIN_STAKE_TO_WORK;
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(31);
      const treasury = user2.account.address;

      await reputationRegistry.write.setTreasury([treasury], { account: owner.account });

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, stakeAmount]);
      await eccoToken.write.approve([reputationRegistry.address, stakeAmount], { account: user1.account });
      await reputationRegistry.write.stake([stakeAmount], { account: user1.account });

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
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(32);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE * 4n]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE * 4n], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE * 4n], { account: user1.account });

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

    it("should reject setting minStakeToWork to zero", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      try {
        await reputationRegistry.write.setMinStakes([0n, MIN_STAKE_TO_RATE], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Min stake to work must be positive/);
      }
    });

    it("should reject setting minStakeToWork less than minStakeToRate", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const lowWorkStake = parseEther("5");
      const highRateStake = parseEther("10");

      try {
        await reputationRegistry.write.setMinStakes([lowWorkStake, highRateStake], { account: owner.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Work stake must be >= rate stake/);
      }
    });

    it("should allow setting minStakeToWork equal to minStakeToRate", async () => {
      const { reputationRegistry, owner } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const equalStake = parseEther("50");
      await reputationRegistry.write.setMinStakes([equalStake, equalStake], { account: owner.account });

      const minStakeToWork = await reputationRegistry.read.minStakeToWork();
      const minStakeToRate = await reputationRegistry.read.minStakeToRate();
      expect(minStakeToWork).to.equal(equalStake);
      expect(minStakeToRate).to.equal(equalStake);
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
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(33);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("100")]);
      expect(weight > 0n).to.equal(true);
    });

    it("should ensure stakeWeight is at least 1 for any valid staker", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(34);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, MIN_STAKE_TO_RATE]);
      await eccoToken.write.approve([reputationRegistry.address, MIN_STAKE_TO_RATE], { account: user1.account });
      await reputationRegistry.write.stake([MIN_STAKE_TO_RATE], { account: user1.account });

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, parseEther("1")]);
      expect(weight).to.equal(parseEther("1") / BigInt(1e18));
    });

    it("should cap rating weight at int256 max to prevent overflow on cast", async () => {
      const { reputationRegistry, eccoToken, user1, publicClient } = await loadFixtureWithHelpers(deployReputationRegistryFixture);

      const largeStake = parseEther("1000000000");
      const peerId = generatePeerId(user1.account.address);
      const salt = generateSalt(35);

      await registerPeerIdWithCommitReveal(reputationRegistry, publicClient, user1, peerId, salt);

      await eccoToken.write.mint([user1.account.address, largeStake]);
      await eccoToken.write.approve([reputationRegistry.address, largeStake], { account: user1.account });
      await reputationRegistry.write.stake([largeStake], { account: user1.account });

      const maxInt256 = (2n ** 255n) - 1n;
      const extremePayment = maxInt256 * 2n;

      const weight = await reputationRegistry.read.getRatingWeight([user1.account.address, extremePayment]);

      expect(weight).to.equal(maxInt256);
    });
  });
});
