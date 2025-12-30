import { network } from "hardhat";
import { encodeFunctionData, getContract, parseEther, type Address } from "viem";
import { CONTRACT_ADDRESSES } from "../../addresses";
import { ECCO_GOVERNOR_ABI, ECCO_TOKEN_ABI } from "../../dist/abis";

const MINT_TO = process.env.MINT_TO as Address | undefined;
const MINT_AMOUNT = process.env.MINT_AMOUNT ? parseEther(process.env.MINT_AMOUNT) : parseEther("1000000");
const DESCRIPTION = process.env.DESCRIPTION ?? `Mint ${process.env.MINT_AMOUNT ?? "1000000"} ECCO tokens`;

async function main() {
  if (!MINT_TO) {
    throw new Error("MINT_TO environment variable required");
  }

  const connection = await network.connect();
  const { viem } = connection;
  const [proposer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  console.log("Creating mint proposal with account:", proposer.account.address);

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

  const proposalThreshold = await eccoGovernor.read.proposalThreshold();
  const votes = await eccoToken.read.getVotes([proposer.account.address]);

  console.log("\n--- Proposal Requirements ---");
  console.log("Proposal threshold:", proposalThreshold.toString());
  console.log("Your voting power:", votes.toString());

  if (votes < proposalThreshold) {
    throw new Error(`Insufficient voting power. Need ${proposalThreshold}, have ${votes}`);
  }

  const mintCalldata = encodeFunctionData({
    abi: ECCO_TOKEN_ABI,
    functionName: "mint",
    args: [MINT_TO, MINT_AMOUNT],
  });

  console.log("\n--- Proposal Details ---");
  console.log("Target:", addresses.eccoToken);
  console.log("Mint to:", MINT_TO);
  console.log("Amount:", MINT_AMOUNT.toString());
  console.log("Description:", DESCRIPTION);

  console.log("\n--- Creating Proposal ---");
  const hash = await proposer.writeContract({
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: "propose",
    args: [[addresses.eccoToken], [0n], [mintCalldata], DESCRIPTION],
    chain: proposer.chain,
    account: proposer.account,
  });
  console.log("Transaction hash:", hash);

  console.log("Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error(`Transaction failed: ${hash}`);
  }

  const proposalCreatedLog = receipt.logs.find((log) => {
    return log.topics[0] === "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0";
  });

  if (proposalCreatedLog && proposalCreatedLog.topics[1]) {
    const proposalId = BigInt(proposalCreatedLog.topics[1]);
    console.log("\n--- Proposal Created ---");
    console.log("Proposal ID:", proposalId.toString());
    console.log("\nNext steps:");
    console.log("1. Wait for voting delay to pass");
    console.log("2. Run: PROPOSAL_ID=" + proposalId.toString() + " bun run scripts/governance/vote.ts");
  } else {
    console.log("\nProposal created. Check transaction logs for proposal ID.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
