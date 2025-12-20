import { network } from "hardhat";
import { formatEther, getContract } from "viem";
import { CONTRACT_ADDRESSES } from "../../addresses";
import { ECCO_GOVERNOR_ABI, ECCO_TOKEN_ABI } from "../../dist/abis";

const PROPOSAL_ID = process.env.PROPOSAL_ID;

async function main() {
  if (!PROPOSAL_ID) {
    throw new Error("PROPOSAL_ID environment variable required");
  }

  const connection = await network.connect();
  const { viem } = connection;
  const [account] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  const eccoGovernor = getContract({
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    client: publicClient,
  });

  const eccoToken = getContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    client: publicClient,
  });

  const proposalId = BigInt(PROPOSAL_ID);

  const state = await eccoGovernor.read.state([proposalId]);
  const votes = await eccoGovernor.read.proposalVotes([proposalId]);
  const deadline = await eccoGovernor.read.proposalDeadline([proposalId]);
  const snapshot = await eccoGovernor.read.proposalSnapshot([proposalId]);
  const hasVoted = await eccoGovernor.read.hasVoted([proposalId, account.account.address]);
  const yourVotes = await eccoToken.read.getVotes([account.account.address]);

  const stateNames = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
  const currentBlock = await publicClient.getBlockNumber();

  console.log("=== Proposal Status ===");
  console.log("");
  console.log("Proposal ID:", proposalId.toString());
  console.log("State:", stateNames[state] ?? "Unknown");
  console.log("");
  console.log("--- Voting ---");
  console.log("For:", formatEther(votes[1]), "ECCO");
  console.log("Against:", formatEther(votes[0]), "ECCO");
  console.log("Abstain:", formatEther(votes[2]), "ECCO");
  console.log("");
  console.log("--- Timeline ---");
  console.log("Snapshot block:", snapshot.toString());
  console.log("Deadline block:", deadline.toString());
  console.log("Current block:", currentBlock.toString());
  console.log("Blocks remaining:", deadline > currentBlock ? (deadline - currentBlock).toString() : "Voting ended");
  console.log("");
  console.log("--- Your Status ---");
  console.log("Your voting power:", formatEther(yourVotes), "ECCO");
  console.log("Has voted:", hasVoted);
  console.log("");

  if (state === 0) {
    console.log(">>> Proposal is pending. Voting hasn't started yet.");
  } else if (state === 1) {
    console.log(">>> Proposal is active. Cast your vote!");
    console.log("    PROPOSAL_ID=" + proposalId.toString() + " VOTE_TYPE=for bun run scripts/governance/vote.ts");
  } else if (state === 4) {
    console.log(">>> Proposal succeeded! Queue it for execution:");
    console.log("    ACTION=queue bun run scripts/governance/execute.ts");
  } else if (state === 5) {
    console.log(">>> Proposal is queued. Execute after timelock delay:");
    console.log("    ACTION=execute bun run scripts/governance/execute.ts");
  } else if (state === 7) {
    console.log(">>> Proposal has been executed successfully!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
