// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IReputationRegistry {
    function totalStaked() external view returns (uint256);
}
