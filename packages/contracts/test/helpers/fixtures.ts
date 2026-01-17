import hre from "hardhat";
import { parseEther, getAddress } from "viem";
import type { PublicClient } from "viem";
import {
  VOTING_DELAY,
  VOTING_PERIOD,
  PROPOSAL_THRESHOLD,
  QUORUM_PERCENT,
  TIMELOCK_MIN_DELAY,
  INITIAL_CONSTITUTION_ITEMS,
} from "./constants";

async function getViem() {
  const { viem } = await hre.network.connect();
  return viem;
}

export async function getNetworkHelpers() {
  const { networkHelpers } = await hre.network.connect();
  return networkHelpers;
}

type TestRpcSchema = [
  { Method: "evm_increaseTime"; Parameters: [number]; ReturnType: void },
  { Method: "evm_mine"; Parameters: []; ReturnType: void }
];

export async function increaseTime(publicClient: PublicClient, seconds: number | bigint) {
  const transport = publicClient.transport;
  const request = transport.request.bind(transport) as <T extends TestRpcSchema[number]>(
    args: { method: T["Method"]; params: T["Parameters"] }
  ) => Promise<T["ReturnType"]>;
  await request({ method: "evm_increaseTime", params: [Number(seconds)] });
  await request({ method: "evm_mine", params: [] });
}

export async function deployEccoTokenFixture() {
  const viem = await getViem();
  const [owner, user1, user2, user3] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  return { eccoToken, owner, user1, user2, user3, publicClient };
}

export async function deployAgentIdentityRegistryFixture() {
  const viem = await getViem();
  const [owner, user1, user2, user3] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  const identityRegistry = await viem.deployContract(
    "AgentIdentityRegistry",
    [eccoToken.address, owner.account.address]
  );

  const stakeRegistry = await viem.deployContract(
    "AgentStakeRegistry",
    [eccoToken.address, identityRegistry.address, owner.account.address]
  );

  return {
    eccoToken,
    identityRegistry,
    stakeRegistry,
    owner,
    user1,
    user2,
    user3,
    publicClient,
  };
}

export async function deployWorkRewardsFixture() {
  const viem = await getViem();
  const [owner, user1, user2, distributor] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  const identityRegistry = await viem.deployContract(
    "AgentIdentityRegistry",
    [eccoToken.address, owner.account.address]
  );

  const stakeRegistry = await viem.deployContract(
    "AgentStakeRegistry",
    [eccoToken.address, identityRegistry.address, owner.account.address]
  );

  const workRewards = await viem.deployContract("WorkRewards", [
    eccoToken.address,
    stakeRegistry.address,
    owner.account.address,
  ]);

  return {
    eccoToken,
    identityRegistry,
    stakeRegistry,
    workRewards,
    owner,
    user1,
    user2,
    distributor,
    publicClient,
  };
}

export async function deployFeeCollectorFixture() {
  const viem = await getViem();
  const [owner, treasury, user1, user2] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  const identityRegistry = await viem.deployContract(
    "AgentIdentityRegistry",
    [eccoToken.address, owner.account.address]
  );

  const stakeRegistry = await viem.deployContract(
    "AgentStakeRegistry",
    [eccoToken.address, identityRegistry.address, owner.account.address]
  );

  const feeCollector = await viem.deployContract("FeeCollector", [
    eccoToken.address,
    stakeRegistry.address,
    treasury.account.address,
    owner.account.address,
  ]);

  return {
    eccoToken,
    identityRegistry,
    stakeRegistry,
    feeCollector,
    owner,
    treasury,
    user1,
    user2,
    publicClient,
  };
}

export async function deployTimelockFixture() {
  const viem = await getViem();
  const [owner, proposer, executor] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoTimelock = await viem.deployContract("EccoTimelock", [
    TIMELOCK_MIN_DELAY,
    [proposer.account.address],
    [executor.account.address],
    owner.account.address,
  ]);

  return {
    eccoTimelock,
    owner,
    proposer,
    executor,
    publicClient,
  };
}

export async function deployGovernorFixture() {
  const viem = await getViem();
  const [owner, voter1, voter2, voter3] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  const identityRegistry = await viem.deployContract("AgentIdentityRegistry", [
    eccoToken.address,
    owner.account.address,
  ]);

  const stakeRegistry = await viem.deployContract("AgentStakeRegistry", [
    eccoToken.address,
    identityRegistry.address,
    owner.account.address,
  ]);

  const eccoTimelock = await viem.deployContract("EccoTimelock", [
    TIMELOCK_MIN_DELAY,
    [owner.account.address],
    [owner.account.address],
    owner.account.address,
  ]);

  const eccoGovernor = await viem.deployContract("EccoGovernor", [
    eccoToken.address,
    eccoTimelock.address,
    VOTING_DELAY,
    VOTING_PERIOD,
    PROPOSAL_THRESHOLD,
    QUORUM_PERCENT,
    stakeRegistry.address,
  ]);

  const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

  await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.revokeRole([PROPOSER_ROLE, owner.account.address]);
  await eccoTimelock.write.revokeRole([EXECUTOR_ROLE, owner.account.address]);

  await eccoTimelock.write.completeSetup();

  return {
    eccoToken,
    eccoTimelock,
    eccoGovernor,
    stakeRegistry,
    owner,
    voter1,
    voter2,
    voter3,
    publicClient,
  };
}

export async function deployConstitutionFixture() {
  const viem = await getViem();
  const [owner, user1, user2, user3] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoConstitution = await viem.deployContract("EccoConstitution", [
    INITIAL_CONSTITUTION_ITEMS,
    owner.account.address,
  ]);

  return {
    eccoConstitution,
    owner,
    user1,
    user2,
    user3,
    publicClient,
  };
}

export async function deployFullEcosystemFixture() {
  const viem = await getViem();
  const [owner, treasury, user1, user2, user3, distributor] =
    await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.deployContract("EccoToken", [
    owner.account.address,
  ]);

  const identityRegistry = await viem.deployContract(
    "AgentIdentityRegistry",
    [eccoToken.address, owner.account.address]
  );

  const stakeRegistry = await viem.deployContract(
    "AgentStakeRegistry",
    [eccoToken.address, identityRegistry.address, owner.account.address]
  );

  const feeCollector = await viem.deployContract("FeeCollector", [
    eccoToken.address,
    stakeRegistry.address,
    treasury.account.address,
    owner.account.address,
  ]);

  const workRewards = await viem.deployContract("WorkRewards", [
    eccoToken.address,
    stakeRegistry.address,
    owner.account.address,
  ]);

  const eccoTimelock = await viem.deployContract("EccoTimelock", [
    TIMELOCK_MIN_DELAY,
    [owner.account.address],
    [owner.account.address],
    owner.account.address,
  ]);

  const eccoGovernor = await viem.deployContract("EccoGovernor", [
    eccoToken.address,
    eccoTimelock.address,
    VOTING_DELAY,
    VOTING_PERIOD,
    PROPOSAL_THRESHOLD,
    QUORUM_PERCENT,
    stakeRegistry.address,
  ]);

  const PROPOSER_ROLE = await eccoTimelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await eccoTimelock.read.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await eccoTimelock.read.CANCELLER_ROLE();

  await eccoTimelock.write.grantRole([PROPOSER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([EXECUTOR_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.grantRole([CANCELLER_ROLE, eccoGovernor.address]);
  await eccoTimelock.write.revokeRole([PROPOSER_ROLE, owner.account.address]);
  await eccoTimelock.write.revokeRole([EXECUTOR_ROLE, owner.account.address]);

  await eccoTimelock.write.completeSetup();

  const eccoConstitution = await viem.deployContract("EccoConstitution", [
    INITIAL_CONSTITUTION_ITEMS,
    owner.account.address,
  ]);

  await eccoConstitution.write.transferOwnership([eccoTimelock.address]);

  return {
    eccoToken,
    identityRegistry,
    stakeRegistry,
    feeCollector,
    workRewards,
    eccoTimelock,
    eccoGovernor,
    owner,
    treasury,
    user1,
    user2,
    user3,
    distributor,
    publicClient,
  };
}
