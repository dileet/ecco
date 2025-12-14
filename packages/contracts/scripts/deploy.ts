import { network } from "hardhat";
import { formatEther, parseEther } from "viem";

async function main() {
  const connection = await network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deploying contracts with the account:", deployer.account.address);

  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Account balance:", formatEther(balance), "ETH");

  console.log("\n--- Deploying EccoToken ---");
  const eccoToken = await viem.deployContract("EccoToken", [deployer.account.address]);
  console.log("EccoToken deployed to:", eccoToken.address);

  console.log("\n--- Deploying ReputationRegistry ---");
  const reputationRegistry = await viem.deployContract("ReputationRegistry", [
    eccoToken.address,
    deployer.account.address,
  ]);
  console.log("ReputationRegistry deployed to:", reputationRegistry.address);

  console.log("\n--- Deploying FeeCollector ---");
  const feeCollector = await viem.deployContract("FeeCollector", [
    eccoToken.address,
    reputationRegistry.address,
    deployer.account.address,
    deployer.account.address,
  ]);
  console.log("FeeCollector deployed to:", feeCollector.address);

  console.log("\n--- Deploying WorkRewards ---");
  const workRewards = await viem.deployContract("WorkRewards", [
    eccoToken.address,
    reputationRegistry.address,
    deployer.account.address,
  ]);
  console.log("WorkRewards deployed to:", workRewards.address);

  console.log("\n--- Deploying EccoTimelock ---");
  const minDelay = 86400n;
  const eccoTimelock = await viem.deployContract("EccoTimelock", [
    minDelay,
    [],
    [],
    deployer.account.address,
  ]);
  console.log("EccoTimelock deployed to:", eccoTimelock.address);

  console.log("\n--- Deploying EccoGovernor ---");
  const votingDelay = 7200n;
  const votingPeriod = 50400n;
  const proposalThreshold = parseEther("100000");
  const quorumPercent = 4n;
  const eccoGovernor = await viem.deployContract("EccoGovernor", [
    eccoToken.address,
    eccoTimelock.address,
    votingDelay,
    votingPeriod,
    proposalThreshold,
    quorumPercent,
  ]);
  console.log("EccoGovernor deployed to:", eccoGovernor.address);

  console.log("\n--- Setting up Timelock roles ---");
  const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
  await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
  console.log("Granted PROPOSER and EXECUTOR roles to Governor");

  const chainId = await publicClient.getChainId();

  console.log("\n--- Deployment Summary ---");
  console.log("Network:", connection.networkName);
  console.log("Chain ID:", chainId);
  console.log("");
  console.log("EccoToken:", eccoToken.address);
  console.log("ReputationRegistry:", reputationRegistry.address);
  console.log("FeeCollector:", feeCollector.address);
  console.log("WorkRewards:", workRewards.address);
  console.log("EccoTimelock:", eccoTimelock.address);
  console.log("EccoGovernor:", eccoGovernor.address);
  console.log("");
  console.log("Update packages/contracts/dist/addresses.ts with these addresses:");
  console.log(`
  [${chainId}]: {
    eccoToken: '${eccoToken.address}' as const,
    reputationRegistry: '${reputationRegistry.address}' as const,
    feeCollector: '${feeCollector.address}' as const,
    workRewards: '${workRewards.address}' as const,
    eccoGovernor: '${eccoGovernor.address}' as const,
    eccoTimelock: '${eccoTimelock.address}' as const,
  },
`);

  if (connection.networkName === "baseSepolia" || connection.networkName === "baseMainnet") {
    console.log("\n--- Minting initial ECCO tokens for testing ---");
    const mintAmount = parseEther("1000000");
    await eccoToken.write.mint([deployer.account.address, mintAmount]);
    console.log("Minted", formatEther(mintAmount), "ECCO to", deployer.account.address);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
