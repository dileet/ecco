import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, encodeFunctionData, keccak256, toBytes } from "viem";
import hre from "hardhat";
import {
  PROPOSAL_THRESHOLD,
  TIMELOCK_MIN_DELAY,
  VOTING_DELAY,
  VOTING_PERIOD,
  QUORUM_PERCENT,
  INITIAL_CONSTITUTION_ITEMS,
} from "../helpers/constants";

describe("Constitution Governance Integration", () => {
  describe("Adding Items via Governance", () => {
    it("should add constitution item through full governance lifecycle", async () => {
      const { viem, networkHelpers } = await hre.network.connect();
      const [owner, voter1] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [TIMELOCK_MIN_DELAY, [owner.account.address], [owner.account.address], owner.account.address]);
      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
      ]);

      const eccoConstitution = await viem.deployContract("EccoConstitution", [
        INITIAL_CONSTITUTION_ITEMS,
        owner.account.address,
      ]);

      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
      const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

      await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.revokeRole([PROPOSER_ROLE, owner.account.address]);
      await eccoTimelock.write.revokeRole([EXECUTOR_ROLE, owner.account.address]);

      await eccoConstitution.write.transferOwnership([eccoTimelock.address]);

      const totalVotes = parseEther("10000000");
      await eccoToken.write.mint([voter1.account.address, totalVotes]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await networkHelpers.mine(1);

      const newRule = "New governance-approved rule";
      const targets = [eccoConstitution.address];
      const values = [0n];
      const calldatas = [
        encodeFunctionData({
          abi: [{
            name: "addItem",
            type: "function",
            inputs: [{ name: "content", type: "string" }],
            outputs: [{ name: "", type: "uint256" }],
          }],
          functionName: "addItem",
          args: [newRule],
        }),
      ];
      const description = "Proposal: Add new constitution rule";
      const descriptionHash = keccak256(toBytes(description));

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      expect(await eccoGovernor.read.state([proposalId])).to.equal(0);

      const voteStart = await eccoGovernor.read.proposalSnapshot([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteStart) + 1);
      expect(await eccoGovernor.read.state([proposalId])).to.equal(1);

      await eccoGovernor.write.castVote([proposalId, 1], { account: voter1.account });

      const voteEnd = await eccoGovernor.read.proposalDeadline([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteEnd) + 1);
      expect(await eccoGovernor.read.state([proposalId])).to.equal(4);

      await eccoGovernor.write.queue([targets, values, calldatas, descriptionHash], { account: voter1.account });
      expect(await eccoGovernor.read.state([proposalId])).to.equal(5);

      const currentTime = await networkHelpers.time.latest();
      await networkHelpers.time.increaseTo(currentTime + Number(TIMELOCK_MIN_DELAY) + 1);

      const countBefore = await eccoConstitution.read.getItemCount();
      await eccoGovernor.write.execute([targets, values, calldatas, descriptionHash], { account: voter1.account });
      const countAfter = await eccoConstitution.read.getItemCount();

      expect(await eccoGovernor.read.state([proposalId])).to.equal(7);
      expect(countAfter).to.equal(countBefore + 1n);

      const items = await eccoConstitution.read.getAllItems();
      expect(items[items.length - 1]).to.equal(newRule);
    });
  });

  describe("Removing Items via Governance", () => {
    it("should remove constitution item through governance", async () => {
      const { viem, networkHelpers } = await hre.network.connect();
      const [owner, voter1] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [TIMELOCK_MIN_DELAY, [owner.account.address], [owner.account.address], owner.account.address]);
      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
      ]);

      const eccoConstitution = await viem.deployContract("EccoConstitution", [
        INITIAL_CONSTITUTION_ITEMS,
        owner.account.address,
      ]);

      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
      const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

      await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.revokeRole([PROPOSER_ROLE, owner.account.address]);
      await eccoTimelock.write.revokeRole([EXECUTOR_ROLE, owner.account.address]);

      await eccoConstitution.write.transferOwnership([eccoTimelock.address]);

      const totalVotes = parseEther("10000000");
      await eccoToken.write.mint([voter1.account.address, totalVotes]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await networkHelpers.mine(1);

      const targets = [eccoConstitution.address];
      const values = [0n];
      const calldatas = [
        encodeFunctionData({
          abi: [{
            name: "removeItem",
            type: "function",
            inputs: [{ name: "index", type: "uint256" }],
            outputs: [],
          }],
          functionName: "removeItem",
          args: [0n],
        }),
      ];
      const description = "Proposal: Remove first constitution rule";
      const descriptionHash = keccak256(toBytes(description));

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const voteStart = await eccoGovernor.read.proposalSnapshot([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteStart) + 1);

      await eccoGovernor.write.castVote([proposalId, 1], { account: voter1.account });

      const voteEnd = await eccoGovernor.read.proposalDeadline([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteEnd) + 1);

      await eccoGovernor.write.queue([targets, values, calldatas, descriptionHash], { account: voter1.account });

      const currentTime = await networkHelpers.time.latest();
      await networkHelpers.time.increaseTo(currentTime + Number(TIMELOCK_MIN_DELAY) + 1);

      const countBefore = await eccoConstitution.read.getItemCount();
      await eccoGovernor.write.execute([targets, values, calldatas, descriptionHash], { account: voter1.account });
      const countAfter = await eccoConstitution.read.getItemCount();

      expect(countAfter).to.equal(countBefore - 1n);
      expect(await eccoConstitution.read.contentExists([INITIAL_CONSTITUTION_ITEMS[0]])).to.equal(false);
    });
  });

  describe("Non-Governance Cannot Modify", () => {
    it("should reject direct addItem after ownership transferred to timelock", async () => {
      const { viem } = await hre.network.connect();
      const [owner, user1] = await viem.getWalletClients();

      const eccoTimelock = await viem.deployContract("EccoTimelock", [TIMELOCK_MIN_DELAY, [owner.account.address], [owner.account.address], owner.account.address]);
      const eccoConstitution = await viem.deployContract("EccoConstitution", [
        INITIAL_CONSTITUTION_ITEMS,
        owner.account.address,
      ]);

      await eccoConstitution.write.transferOwnership([eccoTimelock.address]);

      try {
        await eccoConstitution.write.addItem(["Unauthorized rule"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }

      try {
        await eccoConstitution.write.addItem(["Unauthorized rule"], { account: user1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });
  });
});
