import { network } from "hardhat";
import { getContract } from "viem";
import { CONTRACT_ADDRESSES } from "../../addresses";
import { ECCO_GOVERNOR_ABI, ECCO_TOKEN_ABI } from "../../dist/abis";

const PROPOSAL_ID = process.env.PROPOSAL_ID;
const VOTE_TYPE = process.env.VOTE_TYPE ?? "for";

async function main() {
  if (!PROPOSAL_ID) {
    throw new Error("PROPOSAL_ID environment variable required");
  }

  const connection = await network.connect();
  const { viem } = connection;
  const [voter] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  console.log("Casting vote with account:", voter.account.address);

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
  const votes = await eccoToken.read.getVotes([voter.account.address]);

  const stateNames = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

  console.log("\n--- Proposal State ---");
  console.log("Proposal ID:", proposalId.toString());
  console.log("State:", stateNames[state] ?? "Unknown");
  console.log("Your voting power:", votes.toString());

  if (state !== 1) {
    throw new Error(`Proposal not active. Current state: ${stateNames[state]}`);
  }

  let support: number;
  switch (VOTE_TYPE.toLowerCase()) {
    case "against":
    case "0":
      support = 0;
      break;
    case "for":
    case "1":
      support = 1;
      break;
    case "abstain":
    case "2":
      support = 2;
      break;
    default:
      throw new Error("Invalid VOTE_TYPE. Use: for, against, or abstain");
  }

  const voteTypeNames = ["Against", "For", "Abstain"];
  console.log("\n--- Casting Vote ---");
  console.log("Vote:", voteTypeNames[support]);

  const hash = await voter.writeContract({
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: "castVote",
    args: [proposalId, support],
    chain: voter.chain,
    account: voter.account,
  });
  console.log("Transaction hash:", hash);

  console.log("Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash });

  const hasVoted = await eccoGovernor.read.hasVoted([proposalId, voter.account.address]);
  console.log("\n--- Vote Cast ---");
  console.log("Has voted:", hasVoted);

  const newState = await eccoGovernor.read.state([proposalId]);
  console.log("New proposal state:", stateNames[newState] ?? "Unknown");

  if (newState === 4) {
    console.log("\nProposal succeeded! Next steps:");
    console.log("1. Run: PROPOSAL_ID=" + proposalId.toString() + " bun run scripts/governance/execute.ts");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
