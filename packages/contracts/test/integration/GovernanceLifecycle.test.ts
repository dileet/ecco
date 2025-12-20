import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, encodeFunctionData, keccak256, toBytes } from "viem";
import hre from "hardhat";
import { PROPOSAL_THRESHOLD, TIMELOCK_MIN_DELAY, VOTING_DELAY, VOTING_PERIOD, QUORUM_PERCENT } from "../helpers/constants";

describe("Governance Lifecycle Tests", () => {
  describe("Complete Proposal Lifecycle", () => {
    it("should complete full proposal lifecycle: propose -> vote -> queue -> execute", async () => {
      const { viem, networkHelpers } = await hre.network.connect();
      const [owner, voter1, voter2, voter3] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [TIMELOCK_MIN_DELAY, [], [], owner.account.address]);
      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
      ]);

      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
      const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

      await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);

      const totalVotes = parseEther("10000000");
      await eccoToken.write.mint([voter1.account.address, totalVotes]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await networkHelpers.mine(1);

      await eccoToken.write.transferOwnership([eccoTimelock.address]);

      const mintAmount = parseEther("1000000");
      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = [
        encodeFunctionData({
          abi: [{
            name: "mint",
            type: "function",
            inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
            outputs: [],
          }],
          functionName: "mint",
          args: [voter2.account.address, mintAmount],
        }),
      ];
      const description = "Proposal: Full lifecycle test";
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

      const balanceBefore = await eccoToken.read.balanceOf([voter2.account.address]);
      await eccoGovernor.write.execute([targets, values, calldatas, descriptionHash], { account: voter1.account });
      const balanceAfter = await eccoToken.read.balanceOf([voter2.account.address]);

      expect(await eccoGovernor.read.state([proposalId])).to.equal(7);
      expect(balanceAfter - balanceBefore).to.equal(mintAmount);
    });
  });

  describe("Proposal Defeat", () => {
    it("should defeat proposal when votes against exceed votes for", async () => {
      const { viem, networkHelpers } = await hre.network.connect();
      const [owner, voter1, voter2, voter3] = await viem.getWalletClients();

      const eccoToken = await viem.deployContract("EccoToken", [owner.account.address]);
      const eccoTimelock = await viem.deployContract("EccoTimelock", [TIMELOCK_MIN_DELAY, [], [], owner.account.address]);
      const eccoGovernor = await viem.deployContract("EccoGovernor", [
        eccoToken.address,
        eccoTimelock.address,
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENT,
      ]);

      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
      const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

      await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
      await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.mint([voter2.account.address, parseEther("5000000")]);
      await eccoToken.write.mint([voter3.account.address, parseEther("6000000")]);

      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await eccoToken.write.delegate([voter2.account.address], { account: voter2.account });
      await eccoToken.write.delegate([voter3.account.address], { account: voter3.account });
      await networkHelpers.mine(1);

      await eccoToken.write.transferOwnership([eccoTimelock.address]);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = [
        encodeFunctionData({
          abi: [{
            name: "mint",
            type: "function",
            inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
            outputs: [],
          }],
          functionName: "mint",
          args: [voter1.account.address, parseEther("1000000")],
        }),
      ];
      const description = "Proposal: Should be defeated";
      const descriptionHash = keccak256(toBytes(description));

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const voteStart = await eccoGovernor.read.proposalSnapshot([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteStart) + 1);

      await eccoGovernor.write.castVote([proposalId, 1], { account: voter2.account });
      await eccoGovernor.write.castVote([proposalId, 0], { account: voter3.account });

      const voteEnd = await eccoGovernor.read.proposalDeadline([proposalId]);
      await networkHelpers.time.increaseTo(Number(voteEnd) + 1);

      expect(await eccoGovernor.read.state([proposalId])).to.equal(3);
    });
  });
});
