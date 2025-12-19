import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, encodeFunctionData, keccak256, toBytes } from "viem";
import { deployGovernorFixture, getNetworkHelpers } from "../helpers/fixtures";
import { mineBlocks } from "../helpers/time";
import { VOTING_DELAY, VOTING_PERIOD, TIMELOCK_MIN_DELAY, PROPOSAL_THRESHOLD } from "../helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("Governance Flow Integration", () => {
  describe("Proposal Creation Flow", () => {
    it("should mint tokens and delegate voting power", async () => {
      const { eccoToken, voter1, voter2 } = await loadFixtureWithHelpers(deployGovernorFixture);

      const totalVotes = parseEther("10000000");
      await eccoToken.write.mint([voter1.account.address, totalVotes / 2n]);
      await eccoToken.write.mint([voter2.account.address, totalVotes / 2n]);

      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await eccoToken.write.delegate([voter2.account.address], { account: voter2.account });
      await mineBlocks(1);

      const voter1Votes = await eccoToken.read.getVotes([voter1.account.address]);
      const voter2Votes = await eccoToken.read.getVotes([voter2.account.address]);

      expect(voter1Votes).to.equal(totalVotes / 2n);
      expect(voter2Votes).to.equal(totalVotes / 2n);
    });

    it("should transfer token ownership to timelock", async () => {
      const { eccoToken, eccoTimelock } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.transferOwnership([eccoTimelock.address]);

      expect(
        (await eccoToken.read.owner()).toLowerCase()
      ).to.equal(eccoTimelock.address.toLowerCase());
    });

    it("should create proposal with governance token actions", async () => {
      const { eccoGovernor, eccoToken, eccoTimelock, voter1 } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

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
          args: [voter1.account.address, mintAmount],
        }),
      ];
      const description = "Proposal #1: Mint 1M tokens";

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const state = await eccoGovernor.read.state([proposalId]);
      expect(state).to.equal(0);

      const proposer = await eccoGovernor.read.proposalProposer([proposalId]);
      expect(proposer.toLowerCase()).to.equal(voter1.account.address.toLowerCase());
    });

    it("should verify governor is linked to timelock", async () => {
      const { eccoGovernor, eccoTimelock } = await loadFixtureWithHelpers(deployGovernorFixture);

      const timelockAddress = await eccoGovernor.read.timelock();
      expect(timelockAddress.toLowerCase()).to.equal(eccoTimelock.address.toLowerCase());
    });

    it("should verify timelock has correct roles for governor", async () => {
      const { eccoGovernor, eccoTimelock } = await loadFixtureWithHelpers(deployGovernorFixture);

      const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();

      const hasProposerRole = await eccoTimelock.read.hasRole([PROPOSER_ROLE, eccoGovernor.address]);
      const hasExecutorRole = await eccoTimelock.read.hasRole([EXECUTOR_ROLE, eccoGovernor.address]);

      expect(hasProposerRole).to.equal(true);
      expect(hasExecutorRole).to.equal(true);
    });
  });
});
