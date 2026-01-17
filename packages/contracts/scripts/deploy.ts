import { network } from "hardhat";
import { formatEther, parseEther, type Address } from "viem";

const FOUNDER_ADDRESS = process.env.FOUNDER_ADDRESS as Address | undefined;
const ECOSYSTEM_ADDRESS = process.env.ECOSYSTEM_ADDRESS as Address | undefined;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS as Address | undefined;

const FOUNDER_AMOUNT = parseEther("15000000");
const ECOSYSTEM_AMOUNT = parseEther("35000000");
const WORK_REWARDS_AMOUNT = parseEther("25000000");
const LIQUIDITY_AMOUNT = parseEther("10000000");
const TREASURY_AMOUNT = parseEther("15000000");

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

  console.log("\n--- Deploying AgentIdentityRegistry ---");
  const agentIdentityRegistry = await viem.deployContract("AgentIdentityRegistry", [
    eccoToken.address,
    deployer.account.address,
  ]);
  console.log("AgentIdentityRegistry deployed to:", agentIdentityRegistry.address);

  console.log("\n--- Deploying AgentStakeRegistry ---");
  const agentStakeRegistry = await viem.deployContract("AgentStakeRegistry", [
    eccoToken.address,
    agentIdentityRegistry.address,
    deployer.account.address,
  ]);
  console.log("AgentStakeRegistry deployed to:", agentStakeRegistry.address);

  console.log("\n--- Deploying AgentReputationRegistry ---");
  const agentReputationRegistry = await viem.deployContract("AgentReputationRegistry", [
    agentIdentityRegistry.address,
  ]);
  console.log("AgentReputationRegistry deployed to:", agentReputationRegistry.address);

  console.log("\n--- Deploying AgentValidationRegistry ---");
  const agentValidationRegistry = await viem.deployContract("AgentValidationRegistry", [
    agentIdentityRegistry.address,
  ]);
  console.log("AgentValidationRegistry deployed to:", agentValidationRegistry.address);

  console.log("\n--- Deploying FeeCollector ---");
  const feeCollector = await viem.deployContract("FeeCollector", [
    eccoToken.address,
    agentStakeRegistry.address,
    deployer.account.address,
    deployer.account.address,
  ]);
  console.log("FeeCollector deployed to:", feeCollector.address);

  console.log("\n--- Deploying WorkRewards ---");
  const workRewards = await viem.deployContract("WorkRewards", [
    eccoToken.address,
    agentStakeRegistry.address,
    deployer.account.address,
  ]);
  console.log("WorkRewards deployed to:", workRewards.address);

  console.log("\n--- Deploying EccoTimelock ---");
  const minDelay = 86400n;
  const eccoTimelock = await viem.deployContract("EccoTimelock", [
    minDelay,
    [deployer.account.address],
    [deployer.account.address],
    deployer.account.address,
  ]);
  console.log("EccoTimelock deployed to:", eccoTimelock.address);

  console.log("\n--- Deploying EccoGovernor ---");
  const votingDelay = 7200;
  const votingPeriod = 50400;
  const proposalThreshold = parseEther("100000");
  const quorumPercent = 4n;
  const eccoGovernor = await viem.deployContract("EccoGovernor", [
    eccoToken.address,
    eccoTimelock.address,
    votingDelay,
    votingPeriod,
    proposalThreshold,
    quorumPercent,
    agentStakeRegistry.address,
  ]);
  console.log("EccoGovernor deployed to:", eccoGovernor.address);

  console.log("\n--- Setting up Timelock roles ---");
  const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();
  await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.revokeRole([PROPOSER_ROLE, deployer.account.address]);
  await eccoTimelock.write.revokeRole([EXECUTOR_ROLE, deployer.account.address]);
  console.log("Granted PROPOSER, EXECUTOR, and CANCELLER roles to Governor");
  console.log("Revoked PROPOSER and EXECUTOR roles from deployer");

  console.log("\n--- Securing Timelock (revoking deployer admin) ---");
  await eccoTimelock.write.completeSetup();
  console.log("Timelock setup complete - deployer admin role revoked");

  console.log("\n--- Deploying EccoConstitution ---");
  const INITIAL_CONSTITUTION_ITEMS = [
    "Agents must provide honest and accurate responses to the best of their ability",
    "Agents must not intentionally disrupt network operations or corrupt shared data",
    "Agents must respect rate limits and not abuse network resources",
  ];
  const eccoConstitution = await viem.deployContract("EccoConstitution", [
    INITIAL_CONSTITUTION_ITEMS,
    deployer.account.address,
  ]);
  console.log("EccoConstitution deployed to:", eccoConstitution.address);

  console.log("\n--- Transferring Contract Ownership to Timelock ---");
  await eccoToken.write.transferOwnership([eccoTimelock.address]);
  console.log("EccoToken ownership transferred to Timelock");
  await agentIdentityRegistry.write.transferOwnership([eccoTimelock.address]);
  console.log("AgentIdentityRegistry ownership transferred to Timelock");
  await agentStakeRegistry.write.transferOwnership([eccoTimelock.address]);
  console.log("AgentStakeRegistry ownership transferred to Timelock");
  await feeCollector.write.transferOwnership([eccoTimelock.address]);
  console.log("FeeCollector ownership transferred to Timelock");
  await workRewards.write.transferOwnership([eccoTimelock.address]);
  console.log("WorkRewards ownership transferred to Timelock");
  await eccoConstitution.write.transferOwnership([eccoTimelock.address]);
  console.log("EccoConstitution ownership transferred to Timelock");

  const chainId = await publicClient.getChainId();

  console.log("\n--- Deployment Summary ---");
  console.log("Network:", connection.networkName);
  console.log("Chain ID:", chainId);
  console.log("");
  console.log("EccoToken:", eccoToken.address);
  console.log("AgentIdentityRegistry:", agentIdentityRegistry.address);
  console.log("AgentReputationRegistry:", agentReputationRegistry.address);
  console.log("AgentValidationRegistry:", agentValidationRegistry.address);
  console.log("AgentStakeRegistry:", agentStakeRegistry.address);
  console.log("FeeCollector:", feeCollector.address);
  console.log("WorkRewards:", workRewards.address);
  console.log("EccoTimelock:", eccoTimelock.address);
  console.log("EccoGovernor:", eccoGovernor.address);
  console.log("EccoConstitution:", eccoConstitution.address);
  console.log("");
  console.log("Update packages/contracts/dist/addresses.ts with these addresses:");
  console.log(`
  [${chainId}]: {
    eccoToken: '${eccoToken.address}' as const,
    agentIdentityRegistry: '${agentIdentityRegistry.address}' as const,
    agentReputationRegistry: '${agentReputationRegistry.address}' as const,
    agentValidationRegistry: '${agentValidationRegistry.address}' as const,
    agentStakeRegistry: '${agentStakeRegistry.address}' as const,
    feeCollector: '${feeCollector.address}' as const,
    workRewards: '${workRewards.address}' as const,
    eccoGovernor: '${eccoGovernor.address}' as const,
    eccoTimelock: '${eccoTimelock.address}' as const,
    eccoConstitution: '${eccoConstitution.address}' as const,
  },
`);

  if (connection.networkName === "monadTestnet" || connection.networkName === "monadMainnet") {
    console.log("\n--- Minting and Distributing 100M ECCO tokens ---");

    const founderAddr = FOUNDER_ADDRESS ?? deployer.account.address;
    const ecosystemAddr = ECOSYSTEM_ADDRESS ?? deployer.account.address;
    const treasuryAddr = TREASURY_ADDRESS ?? deployer.account.address;

    console.log("Founder address:", founderAddr);
    console.log("Ecosystem address:", ecosystemAddr);
    console.log("Treasury address:", treasuryAddr);

    console.log("\nMinting 15M ECCO to Founder...");
    await eccoToken.write.mint([founderAddr, FOUNDER_AMOUNT]);
    console.log("Minted", formatEther(FOUNDER_AMOUNT), "ECCO to founder");

    console.log("\nMinting 35M ECCO to Ecosystem...");
    await eccoToken.write.mint([ecosystemAddr, ECOSYSTEM_AMOUNT]);
    console.log("Minted", formatEther(ECOSYSTEM_AMOUNT), "ECCO to ecosystem");

    console.log("\nMinting 25M ECCO to WorkRewards...");
    await eccoToken.write.mint([workRewards.address, WORK_REWARDS_AMOUNT]);
    console.log("Minted", formatEther(WORK_REWARDS_AMOUNT), "ECCO to WorkRewards");

    console.log("\nMinting 10M ECCO to Deployer for Liquidity...");
    await eccoToken.write.mint([deployer.account.address, LIQUIDITY_AMOUNT]);
    console.log("Minted", formatEther(LIQUIDITY_AMOUNT), "ECCO to deployer for liquidity");

    console.log("\nMinting 15M ECCO to Treasury...");
    await eccoToken.write.mint([treasuryAddr, TREASURY_AMOUNT]);
    console.log("Minted", formatEther(TREASURY_AMOUNT), "ECCO to treasury");

    const totalMinted = FOUNDER_AMOUNT + ECOSYSTEM_AMOUNT + WORK_REWARDS_AMOUNT + LIQUIDITY_AMOUNT + TREASURY_AMOUNT;
    console.log("\n--- Distribution Complete ---");
    console.log("Total minted:", formatEther(totalMinted), "ECCO");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
