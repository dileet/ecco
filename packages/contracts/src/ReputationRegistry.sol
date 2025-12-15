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
        uint256 stake;
        uint256 lastActive;
        uint256 unstakeRequestTime;
        uint256 unstakeAmount;
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

    uint256 public minStakeToWork = 100 * 10 ** 18;
    uint256 public minStakeToRate = 10 * 10 ** 18;

    uint256 public unstakeCooldown = 7 days;
    int8 public constant MAX_RATING_DELTA = 5;

    uint256 public totalStaked;

    event Staked(address indexed peer, uint256 amount);
    event UnstakeRequested(address indexed peer, uint256 amount);
    event Unstaked(address indexed peer, uint256 amount);
    event PaymentRecorded(bytes32 indexed paymentId, address indexed payer, address indexed payee, uint256 amount);
    event Rated(address indexed rater, address indexed ratee, int8 delta, uint256 weight);
    event Slashed(address indexed peer, uint256 amount, string reason);
    event JobCompleted(address indexed peer);

    constructor(address _eccoToken, address _owner) Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Must stake positive amount");
        eccoToken.safeTransferFrom(msg.sender, address(this), amount);
        reputations[msg.sender].stake += amount;
        reputations[msg.sender].lastActive = block.timestamp;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        PeerReputation storage rep = reputations[msg.sender];
        require(amount <= rep.stake, "Insufficient stake");

        rep.unstakeRequestTime = block.timestamp;
        rep.unstakeAmount = amount;

        emit UnstakeRequested(msg.sender, amount);
    }

    function completeUnstake() external nonReentrant {
        PeerReputation storage rep = reputations[msg.sender];
        require(rep.unstakeRequestTime > 0, "No unstake request");
        require(block.timestamp >= rep.unstakeRequestTime + unstakeCooldown, "Cooldown not complete");

        uint256 amount = rep.unstakeAmount;

        rep.stake -= amount;
        rep.unstakeRequestTime = 0;
        rep.unstakeAmount = 0;

        totalStaked -= amount;

        eccoToken.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
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

    function slash(address peer, uint256 percent, string calldata reason) external onlyOwner {
        require(percent <= 100, "Invalid percentage");

        PeerReputation storage rep = reputations[peer];
        uint256 slashAmount = (rep.stake * percent) / 100;

        rep.stake -= slashAmount;
        totalStaked -= slashAmount;

        emit Slashed(peer, slashAmount, reason);
    }

    function canWork(address peer) public view returns (bool) {
        return reputations[peer].stake >= minStakeToWork;
    }

    function canRate(address rater) public view returns (bool) {
        return reputations[rater].stake >= minStakeToRate;
    }

    function getRatingWeight(address rater, uint256 paymentAmount) public view returns (uint256) {
        PeerReputation storage rep = reputations[rater];
        uint256 stakeWeight;

        if (rep.stake >= minStakeToRate) {
            stakeWeight = sqrt(rep.stake / minStakeToRate);
        } else {
            stakeWeight = 1;
        }

        return (paymentAmount * stakeWeight) / 1e18;
    }

    function getEffectiveScore(address peer) public view returns (int256) {
        PeerReputation storage rep = reputations[peer];
        int256 baseScore = rep.score;

        uint256 daysSinceActive = (block.timestamp - rep.lastActive) / 1 days;
        uint256 activityPenalty = daysSinceActive > 30 ? 50 : daysSinceActive * 2;

        return (baseScore * int256(100 - activityPenalty)) / 100;
    }

    function getStakeInfo(address peer)
        external
        view
        returns (uint256 stakeAmount, bool canWorkStatus, int256 effectiveScore)
    {
        PeerReputation storage rep = reputations[peer];
        return (rep.stake, canWork(peer), getEffectiveScore(peer));
    }

    function getReputation(address peer) external view returns (PeerReputation memory) {
        return reputations[peer];
    }

    function setMinStakes(uint256 _minStakeToWork, uint256 _minStakeToRate) external onlyOwner {
        minStakeToWork = _minStakeToWork;
        minStakeToRate = _minStakeToRate;
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
}
