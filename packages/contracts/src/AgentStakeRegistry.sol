// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IFeeCollector {
    function updateRewardDebt(address staker) external;
}

interface IAgentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

contract AgentStakeRegistry is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    struct AgentStake {
        uint256 stake;
        uint256 lastActive;
        uint256 unstakeRequestTime;
        uint256 unstakeAmount;
    }

    IERC20 public immutable eccoToken;
    IAgentIdentityRegistry public immutable identityRegistry;

    uint256 public totalStaked;
    uint256 public minStakeToWork = 100 * 10 ** 18;
    uint256 public unstakeCooldown = 7 days;
    uint256 public activityCooldown = 1 days;

    address public treasury;
    IFeeCollector public feeCollector;

    uint256 public constant MAX_SLASH_PERCENT = 30;
    uint256 public constant MIN_UNSTAKE_COOLDOWN = 1 days;

    mapping(uint256 => AgentStake) public agentStakes;
    mapping(address => uint256[]) private _stakedAgentsByOwner;
    mapping(uint256 => uint256) private _stakedAgentIndex;
    mapping(uint256 => address) private _stakedAgentOwner;

    event Staked(uint256 indexed agentId, address indexed staker, uint256 amount);
    event UnstakeRequested(uint256 indexed agentId, uint256 amount);
    event Unstaked(uint256 indexed agentId, uint256 amount);
    event Slashed(uint256 indexed agentId, uint256 amount, string reason);
    event FeeCollectorSet(address indexed feeCollector);

    constructor(address token, address registry, address owner) Ownable(owner) {
        eccoToken = IERC20(token);
        identityRegistry = IAgentIdentityRegistry(registry);
    }

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        address owner = identityRegistry.ownerOf(agentId);
        require(owner == msg.sender, "Not agent owner");
        require(amount > 0, "Must stake positive amount");

        AgentStake storage agentStake = agentStakes[agentId];
        _ensureAgentOwner(agentId, owner);

        if (agentStake.unstakeRequestTime > 0) {
            agentStake.unstakeRequestTime = 0;
            agentStake.unstakeAmount = 0;
        }

        eccoToken.safeTransferFrom(msg.sender, address(this), amount);
        agentStake.stake += amount;

        if (block.timestamp >= agentStake.lastActive + activityCooldown) {
            agentStake.lastActive = block.timestamp;
        }

        totalStaked += amount;

        if (address(feeCollector) != address(0)) {
            feeCollector.updateRewardDebt(msg.sender);
        }

        emit Staked(agentId, msg.sender, amount);
    }

    function requestUnstake(uint256 agentId, uint256 amount) external nonReentrant {
        address owner = identityRegistry.ownerOf(agentId);
        require(owner == msg.sender, "Not agent owner");

        AgentStake storage agentStake = agentStakes[agentId];
        require(amount <= agentStake.stake, "Insufficient stake");

        agentStake.unstakeRequestTime = block.timestamp;
        agentStake.unstakeAmount = amount;

        emit UnstakeRequested(agentId, amount);
    }

    function completeUnstake(uint256 agentId) external nonReentrant {
        address owner = identityRegistry.ownerOf(agentId);
        require(owner == msg.sender, "Not agent owner");

        AgentStake storage agentStake = agentStakes[agentId];
        require(agentStake.unstakeRequestTime > 0, "No unstake request");
        require(block.timestamp >= agentStake.unstakeRequestTime + unstakeCooldown, "Cooldown not complete");

        uint256 amount = agentStake.unstakeAmount;

        agentStake.stake -= amount;
        agentStake.unstakeRequestTime = 0;
        agentStake.unstakeAmount = 0;

        totalStaked -= amount;

        if (agentStake.stake == 0) {
            _ensureAgentOwner(agentId, owner);
            _removeAgentFromOwner(owner, agentId);
        }

        if (address(feeCollector) != address(0)) {
            feeCollector.updateRewardDebt(msg.sender);
        }

        eccoToken.safeTransfer(msg.sender, amount);

        emit Unstaked(agentId, amount);
    }

    function slash(uint256 agentId, uint256 percent, string calldata reason) external onlyOwner {
        require(percent > 0 && percent <= MAX_SLASH_PERCENT, "Invalid slash percentage");
        require(treasury != address(0), "Treasury not set");

        AgentStake storage agentStake = agentStakes[agentId];
        require(agentStake.stake > 0, "No stake to slash");

        uint256 slashAmount = (agentStake.stake * percent) / 100;

        agentStake.stake -= slashAmount;
        totalStaked -= slashAmount;

        address agentOwner = identityRegistry.ownerOf(agentId);
        if (address(feeCollector) != address(0)) {
            feeCollector.updateRewardDebt(agentOwner);
        }

        eccoToken.safeTransfer(treasury, slashAmount);

        emit Slashed(agentId, slashAmount, reason);
    }

    function canWork(address wallet) public view returns (bool) {
        uint256[] storage agents = _stakedAgentsByOwner[wallet];
        for (uint256 i = 0; i < agents.length; i++) {
            uint256 agentId = agents[i];
            if (identityRegistry.ownerOf(agentId) != wallet) {
                continue;
            }
            if (agentStakes[agentId].stake >= minStakeToWork) {
                return true;
            }
        }
        return false;
    }

    function canWorkAgent(uint256 agentId) public view returns (bool) {
        return agentStakes[agentId].stake >= minStakeToWork;
    }

    function reputations(address wallet) external view returns (
        int256 score,
        uint256 rawPositive,
        uint256 rawNegative,
        uint256 totalJobs,
        uint256 stakeAmount,
        uint256 lastActive,
        uint256 unstakeRequestTime,
        uint256 unstakeAmount
    ) {
        (stakeAmount, lastActive, unstakeRequestTime, unstakeAmount) = _getWalletStakeInfo(wallet);
        return (0, 0, 0, 0, stakeAmount, lastActive, unstakeRequestTime, unstakeAmount);
    }

    function _getWalletStakeInfo(address wallet) internal view returns (
        uint256 totalStakeAmount,
        uint256 latestActive,
        uint256 latestUnstakeRequest,
        uint256 latestUnstakeAmount
    ) {
        uint256[] storage agents = _stakedAgentsByOwner[wallet];
        for (uint256 i = 0; i < agents.length; i++) {
            uint256 agentId = agents[i];
            if (identityRegistry.ownerOf(agentId) != wallet) {
                continue;
            }
            AgentStake storage stakeInfo = agentStakes[agentId];
            totalStakeAmount += stakeInfo.stake;
            if (stakeInfo.lastActive > latestActive) {
                latestActive = stakeInfo.lastActive;
            }
            if (stakeInfo.unstakeRequestTime > latestUnstakeRequest) {
                latestUnstakeRequest = stakeInfo.unstakeRequestTime;
                latestUnstakeAmount = stakeInfo.unstakeAmount;
            }
        }
    }

    function setMinStakeToWork(uint256 newMinStakeToWork) external onlyOwner {
        require(newMinStakeToWork > 0, "Min stake must be positive");
        minStakeToWork = newMinStakeToWork;
    }

    function setUnstakeCooldown(uint256 cooldown) external onlyOwner {
        require(cooldown >= MIN_UNSTAKE_COOLDOWN, "Cooldown below minimum");
        unstakeCooldown = cooldown;
    }

    function setActivityCooldown(uint256 cooldown) external onlyOwner {
        require(cooldown > 0, "Cooldown must be positive");
        activityCooldown = cooldown;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury address");
        treasury = newTreasury;
    }

    function setFeeCollector(address newFeeCollector) external onlyOwner {
        require(newFeeCollector != address(0), "Invalid fee collector address");
        feeCollector = IFeeCollector(newFeeCollector);
        emit FeeCollectorSet(newFeeCollector);
    }

    function syncAgentOwner(uint256 agentId) external {
        address owner = identityRegistry.ownerOf(agentId);
        _ensureAgentOwner(agentId, owner);
    }

    function _ensureAgentOwner(uint256 agentId, address owner) internal {
        address current = _stakedAgentOwner[agentId];
        if (current == owner) {
            return;
        }
        if (current != address(0)) {
            _removeAgentFromOwner(current, agentId);
        }
        _stakedAgentsByOwner[owner].push(agentId);
        _stakedAgentIndex[agentId] = _stakedAgentsByOwner[owner].length;
        _stakedAgentOwner[agentId] = owner;
    }

    function _removeAgentFromOwner(address owner, uint256 agentId) internal {
        uint256 index = _stakedAgentIndex[agentId];
        if (index == 0) {
            return;
        }
        uint256 lastIndex = _stakedAgentsByOwner[owner].length;
        if (lastIndex == 0) {
            return;
        }
        uint256 lastAgentId = _stakedAgentsByOwner[owner][lastIndex - 1];
        if (index != lastIndex) {
            _stakedAgentsByOwner[owner][index - 1] = lastAgentId;
            _stakedAgentIndex[lastAgentId] = index;
        }
        _stakedAgentsByOwner[owner].pop();
        _stakedAgentIndex[agentId] = 0;
        if (_stakedAgentOwner[agentId] == owner) {
            _stakedAgentOwner[agentId] = address(0);
        }
    }
}
