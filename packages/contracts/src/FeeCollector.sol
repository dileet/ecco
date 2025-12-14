// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IReputationRegistry {
    function isEccoStaker(address peer) external view returns (bool);
    function reputations(address peer) external view returns (
        int256 score,
        uint256 rawPositive,
        uint256 rawNegative,
        uint256 totalJobs,
        uint256 ethStake,
        uint256 eccoStake,
        uint256 lastActive,
        uint256 unstakeRequestTime,
        uint256 unstakeEthAmount,
        uint256 unstakeEccoAmount
    );
    function totalStakedEcco() external view returns (uint256);
}

contract FeeCollector is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable eccoToken;
    ERC20Burnable public immutable eccoTokenBurnable;
    IReputationRegistry public immutable reputationRegistry;

    address public treasury;

    uint256 public ethFeePercent = 200;
    uint256 public eccoFeePercent = 50;

    uint256 public stakerShare = 50;
    uint256 public treasuryShare = 30;
    uint256 public burnShare = 20;

    uint256 public totalEthCollected;
    uint256 public totalEccoCollected;
    uint256 public totalEccoBurned;

    mapping(address => uint256) public stakerEthRewards;
    mapping(address => uint256) public stakerEccoRewards;
    mapping(address => uint256) public claimedEthRewards;
    mapping(address => uint256) public claimedEccoRewards;

    uint256 public accEthPerShare;
    uint256 public accEccoPerShare;
    uint256 private constant PRECISION = 1e18;

    mapping(address => uint256) public ethRewardDebt;
    mapping(address => uint256) public eccoRewardDebt;

    event FeeCollected(address indexed payer, address indexed payee, uint256 amount, uint256 fee, bool isEccoStaker);
    event RewardsClaimed(address indexed staker, uint256 ethAmount, uint256 eccoAmount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeesDistributed(uint256 ethToStakers, uint256 eccoToStakers, uint256 ethToTreasury, uint256 eccoToTreasury, uint256 eccoBurned);

    constructor(address _eccoToken, address _reputationRegistry, address _treasury, address _owner) Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
        eccoTokenBurnable = ERC20Burnable(_eccoToken);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        treasury = _treasury;
    }

    function collectFee(address payer, address payee, uint256 amount) external payable nonReentrant returns (uint256 fee) {
        bool isEcco = reputationRegistry.isEccoStaker(payer);
        uint256 feePercent = isEcco ? eccoFeePercent : ethFeePercent;
        fee = (amount * feePercent) / 10000;

        require(msg.value >= fee, "Insufficient fee");

        totalEthCollected += fee;

        if (msg.value > fee) {
            (bool refundSuccess,) = payer.call{value: msg.value - fee}("");
            require(refundSuccess, "Refund failed");
        }

        emit FeeCollected(payer, payee, amount, fee, isEcco);
        return fee;
    }

    function collectFeeInEcco(address payer, address payee, uint256 amount) external nonReentrant returns (uint256 fee) {
        bool isEcco = reputationRegistry.isEccoStaker(payer);
        uint256 feePercent = isEcco ? eccoFeePercent : ethFeePercent;
        fee = (amount * feePercent) / 10000;

        eccoToken.safeTransferFrom(payer, address(this), fee);
        totalEccoCollected += fee;

        emit FeeCollected(payer, payee, amount, fee, isEcco);
        return fee;
    }

    function distributeFees() external nonReentrant {
        uint256 ethBalance = address(this).balance;
        uint256 eccoBalance = eccoToken.balanceOf(address(this));

        require(ethBalance > 0 || eccoBalance > 0, "No fees to distribute");

        uint256 ethToStakers = (ethBalance * stakerShare) / 100;
        uint256 ethToTreasury = (ethBalance * treasuryShare) / 100;

        uint256 eccoToStakers = (eccoBalance * stakerShare) / 100;
        uint256 eccoToTreasury = (eccoBalance * treasuryShare) / 100;
        uint256 eccoBurn = (eccoBalance * burnShare) / 100;

        uint256 totalStaked = reputationRegistry.totalStakedEcco();
        if (totalStaked > 0) {
            accEthPerShare += (ethToStakers * PRECISION) / totalStaked;
            accEccoPerShare += (eccoToStakers * PRECISION) / totalStaked;
        }

        if (ethToTreasury > 0) {
            (bool success,) = treasury.call{value: ethToTreasury}("");
            require(success, "Treasury ETH transfer failed");
        }

        if (eccoToTreasury > 0) {
            eccoToken.safeTransfer(treasury, eccoToTreasury);
        }

        if (eccoBurn > 0) {
            eccoTokenBurnable.burn(eccoBurn);
            totalEccoBurned += eccoBurn;
        }

        emit FeesDistributed(ethToStakers, eccoToStakers, ethToTreasury, eccoToTreasury, eccoBurn);
    }

    function pendingRewards(address staker) public view returns (uint256 ethPending, uint256 eccoPending) {
        (,,,,, uint256 eccoStake,,,,) = reputationRegistry.reputations(staker);

        ethPending = ((eccoStake * accEthPerShare) / PRECISION) - ethRewardDebt[staker];
        eccoPending = ((eccoStake * accEccoPerShare) / PRECISION) - eccoRewardDebt[staker];
    }

    function claimRewards() external nonReentrant {
        (uint256 ethPending, uint256 eccoPending) = pendingRewards(msg.sender);

        (,,,,, uint256 eccoStake,,,,) = reputationRegistry.reputations(msg.sender);
        ethRewardDebt[msg.sender] = (eccoStake * accEthPerShare) / PRECISION;
        eccoRewardDebt[msg.sender] = (eccoStake * accEccoPerShare) / PRECISION;

        if (ethPending > 0) {
            claimedEthRewards[msg.sender] += ethPending;
            (bool success,) = msg.sender.call{value: ethPending}("");
            require(success, "ETH transfer failed");
        }

        if (eccoPending > 0) {
            claimedEccoRewards[msg.sender] += eccoPending;
            eccoToken.safeTransfer(msg.sender, eccoPending);
        }

        emit RewardsClaimed(msg.sender, ethPending, eccoPending);
    }

    function updateRewardDebt(address staker) external {
        (,,,,, uint256 eccoStake,,,,) = reputationRegistry.reputations(staker);
        ethRewardDebt[staker] = (eccoStake * accEthPerShare) / PRECISION;
        eccoRewardDebt[staker] = (eccoStake * accEccoPerShare) / PRECISION;
    }

    function setTreasury(address _treasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setFeePercents(uint256 _ethFeePercent, uint256 _eccoFeePercent) external onlyOwner {
        require(_ethFeePercent <= 1000, "ETH fee too high");
        require(_eccoFeePercent <= 1000, "ECCO fee too high");
        ethFeePercent = _ethFeePercent;
        eccoFeePercent = _eccoFeePercent;
    }

    function setDistributionShares(uint256 _stakerShare, uint256 _treasuryShare, uint256 _burnShare) external onlyOwner {
        require(_stakerShare + _treasuryShare + _burnShare == 100, "Shares must sum to 100");
        stakerShare = _stakerShare;
        treasuryShare = _treasuryShare;
        burnShare = _burnShare;
    }

    function calculateFee(address payer, uint256 amount) external view returns (uint256 feePercent, uint256 feeAmount, bool isEccoDiscount) {
        isEccoDiscount = reputationRegistry.isEccoStaker(payer);
        feePercent = isEccoDiscount ? eccoFeePercent : ethFeePercent;
        feeAmount = (amount * feePercent) / 10000;
    }

    receive() external payable {}
}
