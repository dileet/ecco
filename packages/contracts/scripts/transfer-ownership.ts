import { network } from "hardhat";
import { getContract } from "viem";
import { CONTRACT_ADDRESSES } from "../addresses";
import { ECCO_TOKEN_ABI } from "../dist/abis";

async function main() {
  const connection = await network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  const addresses = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  console.log("Transferring ownership with account:", deployer.account.address);
  console.log("Chain ID:", chainId);

  const eccoToken = getContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    client: publicClient,
  });

  const currentOwner = await eccoToken.read.owner();

  console.log("\n--- Current State ---");
  console.log("EccoToken address:", addresses.eccoToken);
  console.log("Current owner:", currentOwner);
  console.log("Timelock address:", addresses.eccoTimelock);

  if (currentOwner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error("Deployer is not the current owner");
  }

  if (currentOwner.toLowerCase() === addresses.eccoTimelock.toLowerCase()) {
    console.log("\nOwnership already transferred to Timelock");
    return;
  }

  console.log("\n--- Transferring Ownership to Timelock ---");
  const hash = await deployer.writeContract({
    address: addresses.eccoToken,
    abi: ECCO_TOKEN_ABI,
    functionName: "transferOwnership",
    args: [addresses.eccoTimelock],
    chain: deployer.chain,
    account: deployer.account,
  });
  console.log("Transaction hash:", hash);

  console.log("Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash });

  const newOwner = await eccoToken.read.owner();
  console.log("\n--- Transfer Complete ---");
  console.log("New owner:", newOwner);
  console.log("\nFuture mints now require governance proposal + vote + 24hr timelock delay");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
