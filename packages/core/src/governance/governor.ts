import { getContract, encodeFunctionData, keccak256, toBytes } from 'viem';
import { type WalletState, getPublicClient, getWalletClient } from '../payments/wallet';
import { ECCO_GOVERNOR_ABI, ECCO_TIMELOCK_ABI, getContractAddresses } from '@ecco/contracts';

export type ProposalState =
  | 'Pending'
  | 'Active'
  | 'Canceled'
  | 'Defeated'
  | 'Succeeded'
  | 'Queued'
  | 'Expired'
  | 'Executed';

const PROPOSAL_STATES: ProposalState[] = [
  'Pending',
  'Active',
  'Canceled',
  'Defeated',
  'Succeeded',
  'Queued',
  'Expired',
  'Executed',
];

export interface ProposalInfo {
  id: bigint;
  state: ProposalState;
  proposer: string;
  startBlock: bigint;
  endBlock: bigint;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
}

export interface GovernorSettings {
  votingDelay: bigint;
  votingPeriod: bigint;
  proposalThreshold: bigint;
  quorumNumerator: bigint;
}

export interface ProposalAction {
  target: `0x${string}`;
  value: bigint;
  calldata: `0x${string}`;
}

function getGovernorContract(wallet: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  return getContract({
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    client: getPublicClient(wallet, chainId),
  });
}

function getTimelockContract(wallet: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  return getContract({
    address: addresses.eccoTimelock,
    abi: ECCO_TIMELOCK_ABI,
    client: getPublicClient(wallet, chainId),
  });
}

export async function getGovernorSettings(
  wallet: WalletState,
  chainId: number
): Promise<GovernorSettings> {
  const contract = getGovernorContract(wallet, chainId);

  const [votingDelay, votingPeriod, proposalThreshold, quorumNumerator] = await Promise.all([
    contract.read.votingDelay() as Promise<bigint>,
    contract.read.votingPeriod() as Promise<bigint>,
    contract.read.proposalThreshold() as Promise<bigint>,
    contract.read.quorumNumerator() as Promise<bigint>,
  ]);

  return {
    votingDelay,
    votingPeriod,
    proposalThreshold,
    quorumNumerator,
  };
}

export async function propose(
  wallet: WalletState,
  chainId: number,
  actions: ProposalAction[],
  description: string
): Promise<{ proposalId: bigint; txHash: string }> {
  const addresses = getContractAddresses(chainId);

  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value);
  const calldatas = actions.map((a) => a.calldata);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'propose',
    args: [targets, values, calldatas, description],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });

  const descriptionHash = keccak256(toBytes(description));
  const proposalId = await getProposalId(wallet, chainId, targets, values, calldatas, descriptionHash);

  return { proposalId, txHash: hash };
}

export async function getProposalId(
  wallet: WalletState,
  chainId: number,
  targets: `0x${string}`[],
  values: bigint[],
  calldatas: `0x${string}`[],
  descriptionHash: `0x${string}`
): Promise<bigint> {
  const contract = getGovernorContract(wallet, chainId);
  return contract.read.hashProposal([targets, values, calldatas, descriptionHash]) as Promise<bigint>;
}

export async function getProposalState(
  wallet: WalletState,
  chainId: number,
  proposalId: bigint
): Promise<ProposalState> {
  const contract = getGovernorContract(wallet, chainId);
  const state = await contract.read.state([proposalId]) as number;
  return PROPOSAL_STATES[state] ?? 'Pending';
}

export async function castVote(
  wallet: WalletState,
  chainId: number,
  proposalId: bigint,
  support: 0 | 1 | 2
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'castVote',
    args: [proposalId, support],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function castVoteWithReason(
  wallet: WalletState,
  chainId: number,
  proposalId: bigint,
  support: 0 | 1 | 2,
  reason: string
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'castVoteWithReason',
    args: [proposalId, support, reason],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function queueProposal(
  wallet: WalletState,
  chainId: number,
  actions: ProposalAction[],
  descriptionHash: `0x${string}`
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value);
  const calldatas = actions.map((a) => a.calldata);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'queue',
    args: [targets, values, calldatas, descriptionHash],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function executeProposal(
  wallet: WalletState,
  chainId: number,
  actions: ProposalAction[],
  descriptionHash: `0x${string}`
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value);
  const calldatas = actions.map((a) => a.calldata);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'execute',
    args: [targets, values, calldatas, descriptionHash],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function cancelProposal(
  wallet: WalletState,
  chainId: number,
  actions: ProposalAction[],
  descriptionHash: `0x${string}`
): Promise<string> {
  const addresses = getContractAddresses(chainId);

  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value);
  const calldatas = actions.map((a) => a.calldata);

  const hash = await getWalletClient(wallet, chainId).writeContract({
    chain: undefined,
    account: wallet.account,
    address: addresses.eccoGovernor,
    abi: ECCO_GOVERNOR_ABI,
    functionName: 'cancel',
    args: [targets, values, calldatas, descriptionHash],
  });

  await getPublicClient(wallet, chainId).waitForTransactionReceipt({ hash });
  return hash;
}

export async function getVotes(
  wallet: WalletState,
  chainId: number,
  account: `0x${string}`,
  blockNumber: bigint
): Promise<bigint> {
  const contract = getGovernorContract(wallet, chainId);
  return contract.read.getVotes([account, blockNumber]) as Promise<bigint>;
}

export async function hasVoted(
  wallet: WalletState,
  chainId: number,
  proposalId: bigint,
  account: `0x${string}`
): Promise<boolean> {
  const contract = getGovernorContract(wallet, chainId);
  return contract.read.hasVoted([proposalId, account]) as Promise<boolean>;
}

export async function getProposalVotes(
  wallet: WalletState,
  chainId: number,
  proposalId: bigint
): Promise<{ againstVotes: bigint; forVotes: bigint; abstainVotes: bigint }> {
  const contract = getGovernorContract(wallet, chainId);
  const [againstVotes, forVotes, abstainVotes] = await contract.read.proposalVotes([proposalId]) as [bigint, bigint, bigint];
  return { againstVotes, forVotes, abstainVotes };
}

export async function getQuorum(
  wallet: WalletState,
  chainId: number,
  blockNumber: bigint
): Promise<bigint> {
  const contract = getGovernorContract(wallet, chainId);
  return contract.read.quorum([blockNumber]) as Promise<bigint>;
}

export async function getTimelockMinDelay(
  wallet: WalletState,
  chainId: number
): Promise<bigint> {
  const contract = getTimelockContract(wallet, chainId);
  return contract.read.getMinDelay() as Promise<bigint>;
}

export function encodeProposalAction(
  abi: Parameters<typeof encodeFunctionData>[0]['abi'],
  functionName: string,
  args: readonly unknown[]
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName,
    args,
  } as Parameters<typeof encodeFunctionData>[0]);
}

export function hashDescription(description: string): `0x${string}` {
  return keccak256(toBytes(description));
}
