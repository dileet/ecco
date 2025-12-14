// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract ReputationRegistry is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    IERC20 public immutable eccoToken;

    struct PeerReputation {
        int256 score;
        uint256 rawPositive;
        uint256 rawNegative;
        uint256 totalJobs;
        uint256 ethStake;
        uint256 eccoStake;
        uint256 lastActive;
        uint256 unstakeRequestTime;
        uint256 unstakeEthAmount;
        uint256 unstakeEccoAmount;
    }

    struct PaymentRecord {
        address payer;
        address payee;
        uint256 amount;
        uint256 timestamp;
        bool rated;
    }

    mapping(address => PeerReputation) public reputations;
    mapping(bytes32 => PaymentRecord) public payments;
    mapping(address => uint256) public totalStakedEccoAt;

    uint256 public minEthStakeToWork = 0.01 ether;
    uint256 public minEccoStakeToWork = 100 * 10 ** 18;
    uint256 public minEthStakeToRate = 0.001 ether;
    uint256 public minEccoStakeToRate = 10 * 10 ** 18;

    uint256 public eccoRatingWeightBonus = 150;
    uint256 public eccoReputationBonus = 110;
    uint256 public eccoFeeDiscount = 75;
    uint256 public eccoPriorityBoost = 10;

    uint256 public unstakeCooldown = 7 days;
    int8 public constant MAX_RATING_DELTA = 5;

    uint256 public totalStakedEth;
    uint256 public totalStakedEcco;

    event Staked(address indexed peer, uint256 ethAmount, uint256 eccoAmount);
    event UnstakeRequested(address indexed peer, uint256 ethAmount, uint256 eccoAmount);
    event Unstaked(address indexed peer, uint256 ethAmount, uint256 eccoAmount);
    event PaymentRecorded(bytes32 indexed paymentId, address indexed payer, address indexed payee, uint256 amount);
    event Rated(address indexed rater, address indexed ratee, int8 delta, uint256 weight);
    event Slashed(address indexed peer, uint256 ethAmount, uint256 eccoAmount, string reason);
    event JobCompleted(address indexed peer);

    constructor(address _eccoToken, address _owner) Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
    }

    function stakeEth() external payable nonReentrant {
        require(msg.value > 0, "Must stake positive amount");
        reputations[msg.sender].ethStake += msg.value;
        reputations[msg.sender].lastActive = block.timestamp;
        totalStakedEth += msg.value;
        emit Staked(msg.sender, msg.value, 0);
    }

    function stakeEcco(uint256 amount) external nonReentrant {
        require(amount > 0, "Must stake positive amount");
        eccoToken.safeTransferFrom(msg.sender, address(this), amount);
        reputations[msg.sender].eccoStake += amount;
        reputations[msg.sender].lastActive = block.timestamp;
        totalStakedEcco += amount;
        emit Staked(msg.sender, 0, amount);
    }

    function requestUnstake(uint256 ethAmount, uint256 eccoAmount) external nonReentrant {
        PeerReputation storage rep = reputations[msg.sender];
        require(ethAmount <= rep.ethStake, "Insufficient ETH stake");
        require(eccoAmount <= rep.eccoStake, "Insufficient ECCO stake");

        rep.unstakeRequestTime = block.timestamp;
        rep.unstakeEthAmount = ethAmount;
        rep.unstakeEccoAmount = eccoAmount;

        emit UnstakeRequested(msg.sender, ethAmount, eccoAmount);
    }

    function completeUnstake() external nonReentrant {
        PeerReputation storage rep = reputations[msg.sender];
        require(rep.unstakeRequestTime > 0, "No unstake request");
        require(block.timestamp >= rep.unstakeRequestTime + unstakeCooldown, "Cooldown not complete");

        uint256 ethAmount = rep.unstakeEthAmount;
        uint256 eccoAmount = rep.unstakeEccoAmount;

        rep.ethStake -= ethAmount;
        rep.eccoStake -= eccoAmount;
        rep.unstakeRequestTime = 0;
        rep.unstakeEthAmount = 0;
        rep.unstakeEccoAmount = 0;

        totalStakedEth -= ethAmount;
        totalStakedEcco -= eccoAmount;

        if (ethAmount > 0) {
            (bool success,) = msg.sender.call{value: ethAmount}("");
            require(success, "ETH transfer failed");
        }
        if (eccoAmount > 0) {
            eccoToken.safeTransfer(msg.sender, eccoAmount);
        }

        emit Unstaked(msg.sender, ethAmount, eccoAmount);
    }

    function recordPayment(bytes32 paymentId, address payee, uint256 amount) external {
        require(payments[paymentId].timestamp == 0, "Payment already recorded");
        require(payee != address(0), "Invalid payee");
        require(amount > 0, "Invalid amount");

        payments[paymentId] = PaymentRecord({
            payer: msg.sender,
            payee: payee,
            amount: amount,
            timestamp: block.timestamp,
            rated: false
        });

        reputations[payee].totalJobs += 1;
        reputations[payee].lastActive = block.timestamp;

        emit PaymentRecorded(paymentId, msg.sender, payee, amount);
        emit JobCompleted(payee);
    }

    function rateAfterPayment(bytes32 paymentId, int8 delta) external nonReentrant {
        PaymentRecord storage payment = payments[paymentId];
        require(payment.timestamp > 0, "Payment not found");
        require(payment.payer == msg.sender, "Only payer can rate");
        require(!payment.rated, "Already rated");
        require(delta >= -MAX_RATING_DELTA && delta <= MAX_RATING_DELTA, "Invalid rating delta");
        require(canRate(msg.sender), "Insufficient stake to rate");

        payment.rated = true;

        uint256 weight = getRatingWeight(msg.sender, payment.amount);
        PeerReputation storage rateeRep = reputations[payment.payee];

        if (delta > 0) {
            rateeRep.rawPositive += uint256(int256(delta));
            rateeRep.score += int256(delta) * int256(weight);
        } else if (delta < 0) {
            rateeRep.rawNegative += uint256(int256(-delta));
            rateeRep.score += int256(delta) * int256(weight);
        }

        emit Rated(msg.sender, payment.payee, delta, weight);
    }

    function batchRate(bytes32[] calldata paymentIds, int8[] calldata deltas) external nonReentrant {
        require(paymentIds.length == deltas.length, "Length mismatch");
        require(canRate(msg.sender), "Insufficient stake to rate");

        for (uint256 i = 0; i < paymentIds.length; i++) {
            PaymentRecord storage payment = payments[paymentIds[i]];
            require(payment.timestamp > 0, "Payment not found");
            require(payment.payer == msg.sender, "Only payer can rate");
            require(!payment.rated, "Already rated");
            require(
                deltas[i] >= -MAX_RATING_DELTA && deltas[i] <= MAX_RATING_DELTA, "Invalid rating delta"
            );

            payment.rated = true;

            uint256 weight = getRatingWeight(msg.sender, payment.amount);
            PeerReputation storage rateeRep = reputations[payment.payee];

            if (deltas[i] > 0) {
                rateeRep.rawPositive += uint256(int256(deltas[i]));
                rateeRep.score += int256(deltas[i]) * int256(weight);
            } else if (deltas[i] < 0) {
                rateeRep.rawNegative += uint256(int256(-deltas[i]));
                rateeRep.score += int256(deltas[i]) * int256(weight);
            }

            emit Rated(msg.sender, payment.payee, deltas[i], weight);
        }
    }

    function slash(address peer, uint256 ethPercent, uint256 eccoPercent, string calldata reason) external onlyOwner {
        require(ethPercent <= 100 && eccoPercent <= 100, "Invalid percentage");

        PeerReputation storage rep = reputations[peer];
        uint256 ethSlash = (rep.ethStake * ethPercent) / 100;
        uint256 eccoSlash = (rep.eccoStake * eccoPercent) / 100;

        rep.ethStake -= ethSlash;
        rep.eccoStake -= eccoSlash;
        totalStakedEth -= ethSlash;
        totalStakedEcco -= eccoSlash;

        emit Slashed(peer, ethSlash, eccoSlash, reason);
    }

    function canWork(address peer) public view returns (bool) {
        PeerReputation storage rep = reputations[peer];
        return rep.ethStake >= minEthStakeToWork || rep.eccoStake >= minEccoStakeToWork;
    }

    function canRate(address rater) public view returns (bool) {
        PeerReputation storage rep = reputations[rater];
        return rep.ethStake >= minEthStakeToRate || rep.eccoStake >= minEccoStakeToRate;
    }

    function isEccoStaker(address peer) public view returns (bool) {
        return reputations[peer].eccoStake >= minEccoStakeToWork;
    }

    function getRatingWeight(address rater, uint256 paymentAmount) public view returns (uint256) {
        PeerReputation storage rep = reputations[rater];
        uint256 stakeWeight;

        if (rep.eccoStake >= minEccoStakeToRate) {
            stakeWeight = (sqrt(rep.eccoStake / minEccoStakeToRate) * eccoRatingWeightBonus) / 100;
        } else if (rep.ethStake >= minEthStakeToRate) {
            stakeWeight = sqrt(rep.ethStake / minEthStakeToRate);
        } else {
            stakeWeight = 1;
        }

        return (paymentAmount * stakeWeight) / 1e18;
    }

    function getEffectiveScore(address peer) public view returns (int256) {
        PeerReputation storage rep = reputations[peer];
        int256 baseScore = rep.score;

        if (rep.eccoStake >= minEccoStakeToWork) {
            baseScore = (baseScore * int256(eccoReputationBonus)) / 100;
        }

        uint256 daysSinceActive = (block.timestamp - rep.lastActive) / 1 days;
        uint256 activityPenalty = daysSinceActive > 30 ? 50 : daysSinceActive * 2;

        return (baseScore * int256(100 - activityPenalty)) / 100;
    }

    function getSelectionScore(address peer) public view returns (int256) {
        int256 effectiveScore = getEffectiveScore(peer);

        if (reputations[peer].eccoStake >= minEccoStakeToWork) {
            effectiveScore += int256(eccoPriorityBoost);
        }

        return effectiveScore;
    }

    function getStakeInfo(address peer)
        external
        view
        returns (uint256 ethStake, uint256 eccoStake, bool _isEccoStaker, int256 effectiveScore)
    {
        PeerReputation storage rep = reputations[peer];
        return (rep.ethStake, rep.eccoStake, isEccoStaker(peer), getEffectiveScore(peer));
    }

    function getReputation(address peer) external view returns (PeerReputation memory) {
        return reputations[peer];
    }

    function setMinStakes(
        uint256 _minEthStakeToWork,
        uint256 _minEccoStakeToWork,
        uint256 _minEthStakeToRate,
        uint256 _minEccoStakeToRate
    ) external onlyOwner {
        minEthStakeToWork = _minEthStakeToWork;
        minEccoStakeToWork = _minEccoStakeToWork;
        minEthStakeToRate = _minEthStakeToRate;
        minEccoStakeToRate = _minEccoStakeToRate;
    }

    function setEccoBonuses(uint256 _ratingWeightBonus, uint256 _reputationBonus, uint256 _feeDiscount, uint256 _priorityBoost)
        external
        onlyOwner
    {
        eccoRatingWeightBonus = _ratingWeightBonus;
        eccoReputationBonus = _reputationBonus;
        eccoFeeDiscount = _feeDiscount;
        eccoPriorityBoost = _priorityBoost;
    }

    function setUnstakeCooldown(uint256 _cooldown) external onlyOwner {
        unstakeCooldown = _cooldown;
    }

    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    receive() external payable {
        reputations[msg.sender].ethStake += msg.value;
        totalStakedEth += msg.value;
        emit Staked(msg.sender, msg.value, 0);
    }
}
