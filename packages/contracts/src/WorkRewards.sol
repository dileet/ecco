// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IReputationRegistry {
    function canWork(address peer) external view returns (bool);
}

contract WorkRewards is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable eccoToken;
    IReputationRegistry public immutable reputationRegistry;

    uint256 public baseRewardPerJob = 1 ether;
    uint256 public consensusBonus = 50;
    uint256 public fastResponseBonus = 25;
    uint256 public stakerBonus = 10;

    uint256 public maxDifficultyMultiplier = 10;
    uint256 public difficultyDivisor = 1000;
    uint256 public maxQualityMultiplier = 300;

    uint256[4] public halvingThresholds = [5_000_000, 15_000_000, 35_000_000, 75_000_000];
    uint256[5] public rewardPerEpoch = [1 ether, 0.5 ether, 0.25 ether, 0.125 ether, 0.0625 ether];
    bool public halvingEnabled = true;

    uint256 public totalRewardsDistributed;
    uint256 public totalJobsRewarded;

    mapping(bytes32 => bool) public rewardedJobs;
    mapping(address => uint256) public peerRewards;
    mapping(address => uint256) public peerJobCount;

    address[] public authorizedDistributors;
    mapping(address => bool) public isAuthorizedDistributor;

    event RewardDistributed(
        bytes32 indexed jobId,
        address indexed peer,
        uint256 baseAmount,
        uint256 finalAmount,
        bool consensusAchieved,
        bool fastResponse,
        uint256 difficulty
    );
    event DistributorAdded(address indexed distributor);
    event DistributorRemoved(address indexed distributor);
    event RewardParametersUpdated(
        uint256 baseReward,
        uint256 consensusBonus,
        uint256 fastResponseBonus,
        uint256 stakerBonus
    );

    modifier onlyAuthorized() {
        require(isAuthorizedDistributor[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(
        address _eccoToken,
        address _reputationRegistry,
        address _owner
    ) Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
    }

    function distributeReward(
        bytes32 jobId,
        address peer,
        uint256 difficulty,
        bool consensusAchieved,
        bool fastResponse
    ) external onlyAuthorized nonReentrant returns (uint256) {
        require(!rewardedJobs[jobId], "Job already rewarded");
        require(reputationRegistry.canWork(peer), "Peer cannot work");

        rewardedJobs[jobId] = true;

        uint256 reward = calculateReward(peer, difficulty, consensusAchieved, fastResponse);

        uint256 balance = eccoToken.balanceOf(address(this));
        if (reward > balance) {
            reward = balance;
        }

        if (reward > 0) {
            eccoToken.safeTransfer(peer, reward);
            totalRewardsDistributed += reward;
            peerRewards[peer] += reward;
        }

        totalJobsRewarded += 1;
        peerJobCount[peer] += 1;

        emit RewardDistributed(
            jobId,
            peer,
            getCurrentBaseReward(),
            reward,
            consensusAchieved,
            fastResponse,
            difficulty
        );

        return reward;
    }

    struct BatchRewardInput {
        bytes32 jobId;
        address peer;
        uint256 difficulty;
        bool consensusAchieved;
        bool fastResponse;
    }

    function distributeBatchRewards(
        BatchRewardInput[] calldata inputs
    ) external onlyAuthorized nonReentrant returns (uint256 totalDistributed) {
        uint256[] memory rewards = new uint256[](inputs.length);
        bool[] memory eligible = new bool[](inputs.length);
        uint256 totalRequired = 0;

        for (uint256 i = 0; i < inputs.length; i++) {
            BatchRewardInput calldata input = inputs[i];

            if (rewardedJobs[input.jobId]) continue;
            if (!reputationRegistry.canWork(input.peer)) continue;

            eligible[i] = true;
            rewards[i] = calculateReward(
                input.peer,
                input.difficulty,
                input.consensusAchieved,
                input.fastResponse
            );
            totalRequired += rewards[i];
        }

        uint256 balance = eccoToken.balanceOf(address(this));
        require(balance >= totalRequired, "Insufficient balance for batch");

        for (uint256 i = 0; i < inputs.length; i++) {
            if (!eligible[i]) continue;

            BatchRewardInput calldata input = inputs[i];
            uint256 reward = rewards[i];

            rewardedJobs[input.jobId] = true;

            if (reward > 0) {
                eccoToken.safeTransfer(input.peer, reward);
                totalRewardsDistributed += reward;
                peerRewards[input.peer] += reward;
                totalDistributed += reward;
            }

            totalJobsRewarded += 1;
            peerJobCount[input.peer] += 1;

            emit RewardDistributed(
                input.jobId,
                input.peer,
                getCurrentBaseReward(),
                reward,
                input.consensusAchieved,
                input.fastResponse,
                input.difficulty
            );
        }
    }

    function getCurrentEpoch() public view returns (uint256) {
        for (uint256 i = 0; i < halvingThresholds.length; i++) {
            if (totalJobsRewarded < halvingThresholds[i]) {
                return i;
            }
        }
        return halvingThresholds.length;
    }

    function getCurrentBaseReward() public view returns (uint256) {
        if (!halvingEnabled) {
            return baseRewardPerJob;
        }
        uint256 epoch = getCurrentEpoch();
        if (epoch >= rewardPerEpoch.length) {
            epoch = rewardPerEpoch.length - 1;
        }
        return rewardPerEpoch[epoch];
    }

    function calculateReward(
        address,
        uint256 difficulty,
        bool consensusAchieved,
        bool fastResponse
    ) public view returns (uint256) {
        uint256 difficultyMultiplier = difficulty / difficultyDivisor;
        if (difficultyMultiplier > maxDifficultyMultiplier) {
            difficultyMultiplier = maxDifficultyMultiplier;
        }
        if (difficultyMultiplier == 0) {
            difficultyMultiplier = 1;
        }

        uint256 qualityMultiplier = 100;
        if (consensusAchieved) {
            qualityMultiplier += consensusBonus;
        }
        if (fastResponse) {
            qualityMultiplier += fastResponseBonus;
        }
        qualityMultiplier += stakerBonus;

        if (qualityMultiplier > maxQualityMultiplier) {
            qualityMultiplier = maxQualityMultiplier;
        }

        uint256 currentBaseReward = getCurrentBaseReward();
        return (currentBaseReward * difficultyMultiplier * qualityMultiplier) / 100;
    }

    function estimateReward(
        address peer,
        uint256 difficulty,
        bool consensusAchieved,
        bool fastResponse
    ) external view returns (uint256) {
        return calculateReward(peer, difficulty, consensusAchieved, fastResponse);
    }

    function addDistributor(address distributor) external onlyOwner {
        require(!isAuthorizedDistributor[distributor], "Already authorized");
        isAuthorizedDistributor[distributor] = true;
        authorizedDistributors.push(distributor);
        emit DistributorAdded(distributor);
    }

    function removeDistributor(address distributor) external onlyOwner {
        require(isAuthorizedDistributor[distributor], "Not authorized");
        isAuthorizedDistributor[distributor] = false;

        for (uint256 i = 0; i < authorizedDistributors.length; i++) {
            if (authorizedDistributors[i] == distributor) {
                authorizedDistributors[i] = authorizedDistributors[authorizedDistributors.length - 1];
                authorizedDistributors.pop();
                break;
            }
        }

        emit DistributorRemoved(distributor);
    }

    function setRewardParameters(
        uint256 _baseRewardPerJob,
        uint256 _consensusBonus,
        uint256 _fastResponseBonus,
        uint256 _stakerBonus
    ) external onlyOwner {
        require(_baseRewardPerJob > 0, "Base reward must be positive");
        require(_baseRewardPerJob <= 1000 ether, "Base reward too high");
        require(_consensusBonus <= 200, "Consensus bonus exceeds 200%");
        require(_fastResponseBonus <= 200, "Fast response bonus exceeds 200%");
        require(_stakerBonus <= 200, "Staker bonus exceeds 200%");

        baseRewardPerJob = _baseRewardPerJob;
        consensusBonus = _consensusBonus;
        fastResponseBonus = _fastResponseBonus;
        stakerBonus = _stakerBonus;

        emit RewardParametersUpdated(
            _baseRewardPerJob,
            _consensusBonus,
            _fastResponseBonus,
            _stakerBonus
        );
    }

    function setDifficultyParameters(
        uint256 _maxDifficultyMultiplier,
        uint256 _difficultyDivisor
    ) external onlyOwner {
        require(_difficultyDivisor > 0, "Divisor cannot be zero");
        maxDifficultyMultiplier = _maxDifficultyMultiplier;
        difficultyDivisor = _difficultyDivisor;
    }

    function setMaxQualityMultiplier(uint256 _maxQualityMultiplier) external onlyOwner {
        require(_maxQualityMultiplier >= 100, "Max quality multiplier must be at least 100");
        require(_maxQualityMultiplier <= 1000, "Max quality multiplier exceeds 1000%");
        maxQualityMultiplier = _maxQualityMultiplier;
    }

    function setHalvingEnabled(bool _enabled) external onlyOwner {
        halvingEnabled = _enabled;
    }

    function setHalvingParameters(
        uint256[4] calldata _thresholds,
        uint256[5] calldata _rewards
    ) external onlyOwner {
        for (uint256 i = 0; i < _thresholds.length; i++) {
            require(_thresholds[i] > 0, "Threshold must be positive");
            if (i > 0) {
                require(_thresholds[i] > _thresholds[i - 1], "Thresholds must be ascending");
            }
        }
        for (uint256 i = 0; i < _rewards.length; i++) {
            require(_rewards[i] > 0, "Reward must be positive");
        }
        halvingThresholds = _thresholds;
        rewardPerEpoch = _rewards;
    }

    function withdrawExcess(address to, uint256 amount) external onlyOwner {
        eccoToken.safeTransfer(to, amount);
    }

    function getDistributors() external view returns (address[] memory) {
        return authorizedDistributors;
    }

    function getPeerStats(address peer) external view returns (
        uint256 totalEarned,
        uint256 jobsCompleted,
        bool canWork
    ) {
        return (
            peerRewards[peer],
            peerJobCount[peer],
            reputationRegistry.canWork(peer)
        );
    }

    function getRewardsPoolBalance() external view returns (uint256) {
        return eccoToken.balanceOf(address(this));
    }
}
