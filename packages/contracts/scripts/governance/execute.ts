import { network } from "hardhat";
import { keccak256, toBytes, encodeFunctionData, parseEther, getContract, type Address } from "viem";
import { CONTRACT_ADDRESSES } from "../../addresses";
import { ECCO_GOVERNOR_ABI, ECCO_TOKEN_ABI } from "../../dist/abis";

const PROPOSAL_ID = process.env.PROPOSAL_ID;
const MINT_TO = process.env.MINT_TO as Address | undefined;
const MINT_AMOUNT = process.env.MINT_AMOUNT ? parseEther(process.env.MINT_AMOUNT) : parseEther("1000000");
const DESCRIPTION = process.env.DESCRIPTION ?? `Mint ${process.env.MINT_AMOUNT ?? "1000000"} ECCO tokens`;
const ACTION = process.env.ACTION ?? "check";

async function main() {
  if (!PROPOSAL_ID) {
    throw new Error("PROPOSAL_ID environment variable required");
  }

  const connection = await network.connect();
  const { viem } = connection;
  const [executor] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  console.log("Executing with account:", executor.account.address);

  const eccoGovernor = getContract({
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    client: publicClient,
  });

  const proposalId = BigInt(PROPOSAL_ID);
  const state = await eccoGovernor.read.state([proposalId]);

  const stateNames = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

  console.log("\n--- Proposal State ---");
  console.log("Proposal ID:", proposalId.toString());
  console.log("State:", stateNames[state] ?? "Unknown");

  if (ACTION === "check") {
    console.log("\nTo queue: ACTION=queue bun run scripts/governance/execute.ts");
    console.log("To execute: ACTION=execute bun run scripts/governance/execute.ts");
    return;
  }

  if (!MINT_TO) {
    throw new Error("MINT_TO environment variable required for queue/execute");
  }

  const mintCalldata = encodeFunctionData({
    abi: ECCO_TOKEN_ABI,
    functionName: "mint",
    args: [MINT_TO, MINT_AMOUNT],
  });

  const descriptionHash = keccak256(toBytes(DESCRIPTION));

  if (ACTION === "queue") {
    if (state !== 4) {
      throw new Error(`Cannot queue. Proposal must be Succeeded. Current: ${stateNames[state]}`);
    }

    console.log("\n--- Queuing Proposal ---");
    const hash = await executor.writeContract({
      address: addresses.eccoGovernor,
      abi: ECCO_GOVERNOR_ABI,
      functionName: "queue",
      args: [[addresses.eccoToken], [0n], [mintCalldata], descriptionHash],
      chain: executor.chain,
      account: executor.account,
    });
    console.log("Transaction hash:", hash);

    console.log("Waiting for confirmation...");
    await publicClient.waitForTransactionReceipt({ hash });

    const newState = await eccoGovernor.read.state([proposalId]);
    console.log("\n--- Proposal Queued ---");
    console.log("New state:", stateNames[newState] ?? "Unknown");
    console.log("\nWait 24 hours for timelock, then run:");
    console.log("ACTION=execute bun run scripts/governance/execute.ts");
  } else if (ACTION === "execute") {
    if (state !== 5) {
      throw new Error(`Cannot execute. Proposal must be Queued. Current: ${stateNames[state]}`);
    }

    console.log("\n--- Executing Proposal ---");
    const hash = await executor.writeContract({
      address: addresses.eccoGovernor,
      abi: ECCO_GOVERNOR_ABI,
      functionName: "execute",
      args: [[addresses.eccoToken], [0n], [mintCalldata], descriptionHash],
      chain: executor.chain,
      account: executor.account,
    });
    console.log("Transaction hash:", hash);

    console.log("Waiting for confirmation...");
    await publicClient.waitForTransactionReceipt({ hash });

    const newState = await eccoGovernor.read.state([proposalId]);
    console.log("\n--- Proposal Executed ---");
    console.log("New state:", stateNames[newState] ?? "Unknown");
    console.log("Tokens have been minted!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
