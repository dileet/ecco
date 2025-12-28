import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, encodeFunctionData, keccak256, toBytes } from "viem";
import { deployGovernorFixture, getNetworkHelpers } from "./helpers/fixtures";
import { mineBlocks } from "./helpers/time";
import { VOTING_DELAY, PROPOSAL_THRESHOLD } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("EccoGovernor", () => {
  describe("Deployment", () => {
    it("should have correct name", async () => {
      const { eccoGovernor } = await loadFixtureWithHelpers(deployGovernorFixture);
      expect(await eccoGovernor.read.name()).to.equal("EccoGovernor");
    });

    it("should be linked to correct token contract", async () => {
      const { eccoGovernor, eccoToken } = await loadFixtureWithHelpers(deployGovernorFixture);
      expect(
        (await eccoGovernor.read.token()).toLowerCase()
      ).to.equal(eccoToken.address.toLowerCase());
    });

    it("should return correct votingDelay", async () => {
      const { eccoGovernor } = await loadFixtureWithHelpers(deployGovernorFixture);
      expect(await eccoGovernor.read.votingDelay()).to.equal(BigInt(VOTING_DELAY));
    });

    it("should return correct proposalThreshold", async () => {
      const { eccoGovernor } = await loadFixtureWithHelpers(deployGovernorFixture);
      expect(await eccoGovernor.read.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
    });
  });

  describe("Proposal Creation", () => {
    it("should allow proposal creation with sufficient voting power", async () => {
      const { eccoGovernor, eccoToken, voter1 } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

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
          args: [voter1.account.address, parseEther("1000")],
        }),
      ];
      const description = "Mint tokens proposal";

      const tx = await eccoGovernor.write.propose(
        [targets, values, calldatas, description],
        { account: voter1.account }
      );

      expect(tx).to.be.ok;
    });

    it("should reject proposal creation below threshold", async () => {
      const { eccoGovernor, eccoToken, voter1 } = await loadFixtureWithHelpers(deployGovernorFixture);

      const belowThreshold = PROPOSAL_THRESHOLD - parseEther("1");
      await eccoToken.write.mint([voter1.account.address, belowThreshold]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test proposal below threshold";

      try {
        await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/GovernorInsufficientProposerVotes/);
      }
    });
  });

  describe("Voting", () => {
    it("should allow voting after voting delay", async () => {
      const { eccoGovernor, eccoToken, voter1, publicClient } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test proposal for voting";

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const snapshot = await eccoGovernor.read.proposalSnapshot([proposalId]);
      const targetTime = Number(snapshot) + 1;

      await publicClient.request({ method: "evm_setNextBlockTimestamp" as never, params: [targetTime] as never });
      await publicClient.request({ method: "evm_mine" as never, params: [] as never });

      await eccoGovernor.write.castVote([proposalId, 1], { account: voter1.account });

      const hasVoted = await eccoGovernor.read.hasVoted([proposalId, voter1.account.address]);
      expect(hasVoted).to.equal(true);
    });
  });

  describe("Proposal State", () => {
    it("should create proposal in pending state", async () => {
      const { eccoGovernor, eccoToken, voter1 } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test proposal state";

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const state = await eccoGovernor.read.state([proposalId]);
      expect(state).to.equal(0);
    });

    it("should have correct proposal snapshot and deadline", async () => {
      const { eccoGovernor, eccoToken, voter1 } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test proposal snapshot";

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const snapshot = await eccoGovernor.read.proposalSnapshot([proposalId]);
      const deadline = await eccoGovernor.read.proposalDeadline([proposalId]);

      expect(snapshot > 0n).to.equal(true);
      expect(deadline > snapshot).to.equal(true);
    });
  });

  describe("Voting Power Snapshot", () => {
    it("should use timestamp before voteStart for snapshot (prevents same-timestamp manipulation)", async () => {
      const { eccoGovernor, eccoToken, voter1, publicClient } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test snapshot timing";

      const block = await publicClient.getBlock();
      const currentTimestamp = block.timestamp;

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const snapshot = await eccoGovernor.read.proposalSnapshot([proposalId]);
      const expectedVoteStart = currentTimestamp + BigInt(VOTING_DELAY) + 1n;

      expect(snapshot).to.equal(expectedVoteStart - 1n);
    });

    it("should not count tokens acquired after snapshot timestamp", async () => {
      const { eccoGovernor, eccoToken, voter1, voter2, publicClient } = await loadFixtureWithHelpers(deployGovernorFixture);

      await eccoToken.write.mint([voter1.account.address, PROPOSAL_THRESHOLD]);
      await eccoToken.write.delegate([voter1.account.address], { account: voter1.account });
      await mineBlocks(1);

      const targets = [eccoToken.address];
      const values = [0n];
      const calldatas = ["0x" as `0x${string}`];
      const description = "Test late token acquisition";

      await eccoGovernor.write.propose([targets, values, calldatas, description], { account: voter1.account });

      const descriptionHash = keccak256(toBytes(description));
      const proposalId = await eccoGovernor.read.hashProposal([targets, values, calldatas, descriptionHash]);

      const snapshot = await eccoGovernor.read.proposalSnapshot([proposalId]);

      await publicClient.request({ method: "evm_increaseTime" as never, params: [Number(VOTING_DELAY) + 100] as never });
      await eccoToken.write.mint([voter2.account.address, parseEther("1000000")]);
      await eccoToken.write.delegate([voter2.account.address], { account: voter2.account });
      await mineBlocks(1);

      const votingPower = await eccoGovernor.read.getVotes([voter2.account.address, snapshot]);
      expect(votingPower).to.equal(0n);
    });
  });
});
