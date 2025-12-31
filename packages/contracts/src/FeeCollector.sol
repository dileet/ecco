// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IReputationRegistry {
    function reputations(address peer) external view returns (
        int256 score,
        uint256 rawPositive,
        uint256 rawNegative,
        uint256 totalJobs,
        uint256 stake,
        uint256 lastActive,
        uint256 unstakeRequestTime,
        uint256 unstakeAmount
    );
    function totalStaked() external view returns (uint256);
}

contract FeeCollector is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable eccoToken;
    ERC20Burnable public immutable eccoTokenBurnable;
    IReputationRegistry public immutable reputationRegistry;

    address public treasury;

    uint256 public feePercent = 10;

    uint256 public treasuryShare = 50;
    uint256 public burnShare = 15;
    uint256 public stakerShare = 35;

    uint256 public totalCollected;
    uint256 public totalBurned;

    mapping(address => uint256) public stakerRewards;
    mapping(address => uint256) public claimedRewards;

    uint256 public accPerShare;
    uint256 private constant PRECISION = 1e18;

    mapping(address => uint256) public rewardDebt;

    event FeeCollected(address indexed payer, address indexed payee, uint256 amount, uint256 fee);
    event RewardsClaimed(address indexed staker, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeesDistributed(uint256 toStakers, uint256 toTreasury, uint256 burned);

    constructor(address _eccoToken, address _reputationRegistry, address _treasury, address _owner) Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
        eccoTokenBurnable = ERC20Burnable(_eccoToken);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        treasury = _treasury;
    }

    function collectFee(address payer, address payee, uint256 amount) external nonReentrant returns (uint256 fee) {
        fee = (amount * feePercent) / 10000;

        eccoToken.safeTransferFrom(payer, address(this), fee);
        totalCollected += fee;

        emit FeeCollected(payer, payee, amount, fee);
        return fee;
    }

    function distributeFees() external nonReentrant {
        uint256 balance = eccoToken.balanceOf(address(this));

        require(balance > 0, "No fees to distribute");

        uint256 toStakers = (balance * stakerShare) / 100;
        uint256 toTreasury = (balance * treasuryShare) / 100;
        uint256 toBurn = (balance * burnShare) / 100;

        uint256 totalStakedAmount = reputationRegistry.totalStaked();
        if (totalStakedAmount > 0) {
            accPerShare += (toStakers * PRECISION) / totalStakedAmount;
        }

        if (toTreasury > 0) {
            eccoToken.safeTransfer(treasury, toTreasury);
        }

        if (toBurn > 0) {
            eccoTokenBurnable.burn(toBurn);
            totalBurned += toBurn;
        }

        emit FeesDistributed(toStakers, toTreasury, toBurn);
    }

    function pendingRewards(address staker) public view returns (uint256) {
        (,,,, uint256 stake,,,) = reputationRegistry.reputations(staker);

        return ((stake * accPerShare) / PRECISION) - rewardDebt[staker];
    }

    function claimRewards() external nonReentrant {
        (,,,, uint256 stake,,,) = reputationRegistry.reputations(msg.sender);

        uint256 currentReward = (stake * accPerShare) / PRECISION;
        uint256 pending = currentReward - rewardDebt[msg.sender];
        rewardDebt[msg.sender] = currentReward;

        if (pending > 0) {
            claimedRewards[msg.sender] += pending;
            eccoToken.safeTransfer(msg.sender, pending);
        }

        emit RewardsClaimed(msg.sender, pending);
    }

    function updateRewardDebt(address staker) external {
        require(msg.sender == address(reputationRegistry), "Only ReputationRegistry");
        (,,,, uint256 stake,,,) = reputationRegistry.reputations(staker);
        rewardDebt[staker] = (stake * accPerShare) / PRECISION;
    }

    function setTreasury(address _treasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setFeePercent(uint256 _feePercent) external onlyOwner {
        require(_feePercent <= 1000, "Fee too high");
        feePercent = _feePercent;
    }

    function setDistributionShares(uint256 _stakerShare, uint256 _treasuryShare, uint256 _burnShare) external onlyOwner {
        require(_stakerShare + _treasuryShare + _burnShare == 100, "Shares must sum to 100");
        stakerShare = _stakerShare;
        treasuryShare = _treasuryShare;
        burnShare = _burnShare;
    }

    function calculateFee(uint256 amount) external view returns (uint256 feeAmount) {
        feeAmount = (amount * feePercent) / 10000;
    }
}
