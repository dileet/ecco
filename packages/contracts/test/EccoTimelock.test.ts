import { describe, it } from "node:test";
import { expect } from "chai";
import { keccak256, toBytes } from "viem";
import { deployTimelockFixture, getNetworkHelpers } from "./helpers/fixtures";
import { TIMELOCK_MIN_DELAY } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("EccoTimelock", () => {
  describe("Deployment", () => {
    it("should set correct minimum delay", async () => {
      const { eccoTimelock } = await loadFixtureWithHelpers(deployTimelockFixture);
      expect(await eccoTimelock.read.getMinDelay()).to.equal(TIMELOCK_MIN_DELAY);
    });

    it("should grant proposer role to specified address", async () => {
      const { eccoTimelock, proposer } = await loadFixtureWithHelpers(deployTimelockFixture);
      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      expect(
        await eccoTimelock.read.hasRole([PROPOSER_ROLE, proposer.account.address])
      ).to.equal(true);
    });

    it("should grant executor role to specified address", async () => {
      const { eccoTimelock, executor } = await loadFixtureWithHelpers(deployTimelockFixture);
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
      expect(
        await eccoTimelock.read.hasRole([EXECUTOR_ROLE, executor.account.address])
      ).to.equal(true);
    });

    it("should set admin correctly", async () => {
      const { eccoTimelock, owner } = await loadFixtureWithHelpers(deployTimelockFixture);
      const DEFAULT_ADMIN_ROLE = await eccoTimelock.read.DEFAULT_ADMIN_ROLE();
      expect(
        await eccoTimelock.read.hasRole([DEFAULT_ADMIN_ROLE, owner.account.address])
      ).to.equal(true);
    });
  });

  describe("Role Management", () => {
    it("should allow admin to grant PROPOSER_ROLE", async () => {
      const { eccoTimelock, executor } = await loadFixtureWithHelpers(deployTimelockFixture);
      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();

      await eccoTimelock.write.grantRole([PROPOSER_ROLE, executor.account.address]);

      expect(
        await eccoTimelock.read.hasRole([PROPOSER_ROLE, executor.account.address])
      ).to.equal(true);
    });

    it("should reject role grant from non-admin", async () => {
      const { eccoTimelock, proposer, executor } = await loadFixtureWithHelpers(deployTimelockFixture);
      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();

      try {
        await eccoTimelock.write.grantRole([PROPOSER_ROLE, executor.account.address], {
          account: proposer.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/AccessControlUnauthorizedAccount/);
      }
    });
  });

  describe("Operation Scheduling", () => {
    it("should allow proposer to schedule operations", async () => {
      const { eccoTimelock, proposer } = await loadFixtureWithHelpers(deployTimelockFixture);

      const target = proposer.account.address;
      const value = 0n;
      const data = "0x" as `0x${string}`;
      const predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const salt = keccak256(toBytes("test-salt"));
      const delay = TIMELOCK_MIN_DELAY;

      await eccoTimelock.write.schedule(
        [target, value, data, predecessor, salt, delay],
        { account: proposer.account }
      );

      const operationId = await eccoTimelock.read.hashOperation([
        target,
        value,
        data,
        predecessor,
        salt,
      ]);

      expect(await eccoTimelock.read.isOperationPending([operationId])).to.equal(true);
    });

    it("should reject scheduling from non-proposer", async () => {
      const { eccoTimelock, executor } = await loadFixtureWithHelpers(deployTimelockFixture);

      const target = executor.account.address;
      const value = 0n;
      const data = "0x" as `0x${string}`;
      const predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const salt = keccak256(toBytes("test-salt-reject"));
      const delay = TIMELOCK_MIN_DELAY;

      try {
        await eccoTimelock.write.schedule(
          [target, value, data, predecessor, salt, delay],
          { account: executor.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/AccessControlUnauthorizedAccount/);
      }
    });
  });

  describe("Operation Execution", () => {
    it("should have operation ready after scheduling", async () => {
      const { eccoTimelock, proposer } = await loadFixtureWithHelpers(deployTimelockFixture);

      const target = proposer.account.address;
      const value = 0n;
      const data = "0x" as `0x${string}`;
      const predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const salt = keccak256(toBytes("test-ready"));
      const delay = TIMELOCK_MIN_DELAY;

      await eccoTimelock.write.schedule(
        [target, value, data, predecessor, salt, delay],
        { account: proposer.account }
      );

      const operationId = await eccoTimelock.read.hashOperation([
        target,
        value,
        data,
        predecessor,
        salt,
      ]);

      const isReady = await eccoTimelock.read.isOperationReady([operationId]);
      expect(isReady).to.equal(false);

      const timestamp = await eccoTimelock.read.getTimestamp([operationId]);
      expect(timestamp > 0n).to.equal(true);
    });

    it("should reject execution before delay", async () => {
      const { eccoTimelock, proposer, executor } = await loadFixtureWithHelpers(deployTimelockFixture);

      const target = executor.account.address;
      const value = 0n;
      const data = "0x" as `0x${string}`;
      const predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const salt = keccak256(toBytes("test-early"));
      const delay = TIMELOCK_MIN_DELAY;

      await eccoTimelock.write.schedule(
        [target, value, data, predecessor, salt, delay],
        { account: proposer.account }
      );

      try {
        await eccoTimelock.write.execute(
          [target, value, data, predecessor, salt],
          { account: executor.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/TimelockUnexpectedOperationState/);
      }
    });
  });

  describe("Operation Cancellation", () => {
    it("should allow canceller to cancel pending operations", async () => {
      const { eccoTimelock, owner, proposer } = await loadFixtureWithHelpers(deployTimelockFixture);

      const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();
      await eccoTimelock.write.grantRole([CANCELLER_ROLE, owner.account.address]);

      const target = proposer.account.address;
      const value = 0n;
      const data = "0x" as `0x${string}`;
      const predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const salt = keccak256(toBytes("test-cancel"));
      const delay = TIMELOCK_MIN_DELAY;

      await eccoTimelock.write.schedule(
        [target, value, data, predecessor, salt, delay],
        { account: proposer.account }
      );

      const operationId = await eccoTimelock.read.hashOperation([
        target,
        value,
        data,
        predecessor,
        salt,
      ]);

      await eccoTimelock.write.cancel([operationId]);

      expect(await eccoTimelock.read.isOperation([operationId])).to.equal(false);
    });
  });
});
