// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/governance/TimelockController.sol";

contract EccoTimelock is TimelockController {
    error SetupAlreadyComplete();
    error NotAdmin();
    error EmptyProposers();
    error EmptyExecutors();
    error MinDelayTooShort();

    uint256 public constant MIN_DELAY = 1 days;

    bool public setupComplete;

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        if (minDelay < MIN_DELAY) revert MinDelayTooShort();
        if (proposers.length == 0) revert EmptyProposers();
        if (executors.length == 0) revert EmptyExecutors();
    }

    function completeSetup() external {
        if (setupComplete) revert SetupAlreadyComplete();
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();

        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
        setupComplete = true;
    }
}
