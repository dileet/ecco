// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IReputationRegistry.sol";

contract EccoGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    uint48 public constant MIN_VOTING_DELAY = 1;

    IReputationRegistry public immutable reputationRegistry;

    uint256 private _circulatingSupply;

    event CirculatingSupplyUpdated(uint256 oldSupply, uint256 newSupply);

    error ProposerAboveThreshold(address proposer, uint256 votes, uint256 threshold);
    error VotingDelayTooShort(uint48 provided, uint48 minimum);
    error CirculatingSupplyTooHigh(uint256 provided, uint256 totalSupply);

    constructor(
        IVotes _token,
        TimelockController _timelock,
        uint48 _votingDelay,
        uint32 _votingPeriod,
        uint256 _proposalThreshold,
        uint256 _quorumPercent,
        IReputationRegistry _reputationRegistry
    )
        Governor("EccoGovernor")
        GovernorSettings(_votingDelay, _votingPeriod, _proposalThreshold)
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(_quorumPercent)
        GovernorTimelockControl(_timelock)
    {
        if (_votingDelay < MIN_VOTING_DELAY) {
            revert VotingDelayTooShort(_votingDelay, MIN_VOTING_DELAY);
        }
        reputationRegistry = _reputationRegistry;
    }

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        uint256 totalSupply = token().getPastTotalSupply(blockNumber);
        uint256 effectiveSupply = _circulatingSupply > 0 && _circulatingSupply < totalSupply
            ? _circulatingSupply
            : totalSupply;
        uint256 stakedTokens = address(reputationRegistry) != address(0)
            ? reputationRegistry.totalStaked()
            : 0;
        uint256 votableSupply = effectiveSupply > stakedTokens ? effectiveSupply - stakedTokens : 0;
        return (votableSupply * quorumNumerator(blockNumber)) / quorumDenominator();
    }

    function circulatingSupply() public view returns (uint256) {
        return _circulatingSupply;
    }

    function setCirculatingSupply(uint256 newCirculatingSupply) public onlyGovernance {
        uint256 currentTotalSupply = IERC20(address(token())).totalSupply();
        if (newCirculatingSupply > currentTotalSupply) {
            revert CirculatingSupplyTooHigh(newCirculatingSupply, currentTotalSupply);
        }
        uint256 oldSupply = _circulatingSupply;
        _circulatingSupply = newCirculatingSupply;
        emit CirculatingSupplyUpdated(oldSupply, newCirculatingSupply);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function setVotingDelay(uint48 newVotingDelay) public override onlyGovernance {
        if (newVotingDelay < MIN_VOTING_DELAY) {
            revert VotingDelayTooShort(newVotingDelay, MIN_VOTING_DELAY);
        }
        super.setVotingDelay(newVotingDelay);
    }

    function proposalSnapshot(uint256 proposalId) public view override returns (uint256) {
        uint256 voteStart = super.proposalSnapshot(proposalId);
        if (voteStart == 0) return 0;
        return voteStart - 1;
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }

    function cancelProposalBelowThreshold(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) public returns (uint256) {
        uint256 proposalId = hashProposal(targets, values, calldatas, descriptionHash);
        address proposer = proposalProposer(proposalId);

        uint256 currentVotes = getVotes(proposer, clock() - 1);
        uint256 threshold = proposalThreshold();

        if (currentVotes >= threshold) {
            revert ProposerAboveThreshold(proposer, currentVotes, threshold);
        }

        return _cancel(targets, values, calldatas, descriptionHash);
    }
}
