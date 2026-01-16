// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IFeeCollector {
    function updateRewardDebt(address staker) external;
}

contract AgentIdentityRegistry is ERC721, EIP712, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    struct AgentStake {
        uint256 stake;
        uint256 lastActive;
        uint256 unstakeRequestTime;
        uint256 unstakeAmount;
    }

    struct MetadataEntry {
        string key;
        bytes value;
    }

    IERC20 public immutable eccoToken;

    uint256 private _nextAgentId = 1;

    mapping(uint256 => string) private _agentURIs;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => AgentStake) public agentStakes;
    mapping(bytes32 => uint256) public peerIdHashToAgentId;

    uint256 public totalStaked;
    uint256 public minStakeToWork = 100 * 10 ** 18;
    uint256 public unstakeCooldown = 7 days;
    uint256 public activityCooldown = 1 days;

    address public treasury;
    IFeeCollector public feeCollector;

    uint256 public constant MAX_SLASH_PERCENT = 30;
    uint256 public constant MIN_UNSTAKE_COOLDOWN = 1 days;

    bytes32 private constant WALLET_TRANSFER_TYPEHASH =
        keccak256("WalletTransfer(uint256 agentId,address newWallet,uint256 deadline)");

    event Registered(uint256 indexed agentId, address indexed owner, string agentURI);
    event URIUpdated(uint256 indexed agentId, string newURI);
    event MetadataSet(uint256 indexed agentId, string key);
    event WalletTransferred(uint256 indexed agentId, address indexed oldWallet, address indexed newWallet);
    event Staked(uint256 indexed agentId, address indexed staker, uint256 amount);
    event UnstakeRequested(uint256 indexed agentId, uint256 amount);
    event Unstaked(uint256 indexed agentId, uint256 amount);
    event Slashed(uint256 indexed agentId, uint256 amount, string reason);
    event PeerIdBound(uint256 indexed agentId, bytes32 indexed peerIdHash);
    event FeeCollectorSet(address indexed feeCollector);

    constructor(
        address _eccoToken,
        address _owner
    ) ERC721("Ecco Agent", "AGENT") EIP712("AgentIdentityRegistry", "1") Ownable(_owner) {
        eccoToken = IERC20(_eccoToken);
    }

    function register(string calldata uri) external returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _mint(msg.sender, agentId);
        _agentURIs[agentId] = uri;
        emit Registered(agentId, msg.sender, uri);
    }

    function registerWithMetadata(
        string calldata uri,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _mint(msg.sender, agentId);
        _agentURIs[agentId] = uri;

        for (uint256 i = 0; i < metadata.length; i++) {
            _metadata[agentId][metadata[i].key] = metadata[i].value;
            emit MetadataSet(agentId, metadata[i].key);
        }

        emit Registered(agentId, msg.sender, uri);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");
        _agentURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI);
    }

    function agentURI(uint256 agentId) external view returns (string memory) {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return _agentURIs[agentId];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return _agentURIs[agentId];
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return _metadata[agentId][key];
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");

        if (keccak256(bytes(key)) == keccak256(bytes("peerIdHash"))) {
            bytes32 oldHash = bytes32(_metadata[agentId][key]);
            if (oldHash != bytes32(0)) {
                delete peerIdHashToAgentId[oldHash];
            }

            bytes32 newHash = bytes32(value);
            require(peerIdHashToAgentId[newHash] == 0 || peerIdHashToAgentId[newHash] == agentId, "PeerId already bound");
            peerIdHashToAgentId[newHash] = agentId;
            emit PeerIdBound(agentId, newHash);
        }

        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key);
    }

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Signature expired");
        require(newWallet != address(0), "Invalid new wallet");

        address currentOwner = ownerOf(agentId);

        bytes32 structHash = keccak256(abi.encode(
            WALLET_TRANSFER_TYPEHASH,
            agentId,
            newWallet,
            deadline
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, signature);

        require(signer == currentOwner, "Invalid signature");

        _transfer(currentOwner, newWallet, agentId);
        emit WalletTransferred(agentId, currentOwner, newWallet);
    }

    function getGlobalId(uint256 agentId) external view returns (string memory) {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return string(abi.encodePacked(
            "eip155:",
            _toString(block.chainid),
            ":",
            _toHexString(address(this)),
            ":",
            _toString(agentId)
        ));
    }

    function getAgentByPeerIdHash(bytes32 peerIdHash) external view returns (uint256) {
        return peerIdHashToAgentId[peerIdHash];
    }

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");
        require(amount > 0, "Must stake positive amount");

        AgentStake storage agentStake = agentStakes[agentId];

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
        require(ownerOf(agentId) == msg.sender, "Not agent owner");

        AgentStake storage agentStake = agentStakes[agentId];
        require(amount <= agentStake.stake, "Insufficient stake");

        agentStake.unstakeRequestTime = block.timestamp;
        agentStake.unstakeAmount = amount;

        emit UnstakeRequested(agentId, amount);
    }

    function completeUnstake(uint256 agentId) external nonReentrant {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");

        AgentStake storage agentStake = agentStakes[agentId];
        require(agentStake.unstakeRequestTime > 0, "No unstake request");
        require(block.timestamp >= agentStake.unstakeRequestTime + unstakeCooldown, "Cooldown not complete");

        uint256 amount = agentStake.unstakeAmount;

        agentStake.stake -= amount;
        agentStake.unstakeRequestTime = 0;
        agentStake.unstakeAmount = 0;

        totalStaked -= amount;

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

        address agentOwner = ownerOf(agentId);
        if (address(feeCollector) != address(0)) {
            feeCollector.updateRewardDebt(agentOwner);
        }

        eccoToken.safeTransfer(treasury, slashAmount);

        emit Slashed(agentId, slashAmount, reason);
    }

    function canWork(address wallet) public view returns (bool) {
        uint256 balance = balanceOf(wallet);
        for (uint256 i = 0; i < balance; i++) {
            uint256 agentId = tokenOfOwnerByIndex(wallet, i);
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
        uint256 balance = balanceOf(wallet);
        for (uint256 i = 0; i < balance; i++) {
            AgentStake storage s = agentStakes[tokenOfOwnerByIndex(wallet, i)];
            totalStakeAmount += s.stake;
            if (s.lastActive > latestActive) latestActive = s.lastActive;
            if (s.unstakeRequestTime > latestUnstakeRequest) {
                latestUnstakeRequest = s.unstakeRequestTime;
                latestUnstakeAmount = s.unstakeAmount;
            }
        }
    }

    function getAgentStake(uint256 agentId) external view returns (AgentStake memory) {
        return agentStakes[agentId];
    }

    function setMinStakeToWork(uint256 _minStakeToWork) external onlyOwner {
        require(_minStakeToWork > 0, "Min stake must be positive");
        minStakeToWork = _minStakeToWork;
    }

    function setUnstakeCooldown(uint256 _cooldown) external onlyOwner {
        require(_cooldown >= MIN_UNSTAKE_COOLDOWN, "Cooldown below minimum");
        unstakeCooldown = _cooldown;
    }

    function setActivityCooldown(uint256 _cooldown) external onlyOwner {
        require(_cooldown > 0, "Cooldown must be positive");
        activityCooldown = _cooldown;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
    }

    function setFeeCollector(address _feeCollector) external onlyOwner {
        require(_feeCollector != address(0), "Invalid fee collector address");
        feeCollector = IFeeCollector(_feeCollector);
        emit FeeCollectorSet(_feeCollector);
    }

    function tokenOfOwnerByIndex(address owner, uint256 index) public view returns (uint256) {
        require(index < balanceOf(owner), "Index out of bounds");
        uint256 count = 0;
        for (uint256 i = 1; i < _nextAgentId; i++) {
            if (_ownerOf(i) == owner) {
                if (count == index) {
                    return i;
                }
                count++;
            }
        }
        revert("Token not found");
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _toHexString(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(uint160(addr) >> (8 * (19 - i)) >> 4) & 0x0f];
            str[3 + i * 2] = alphabet[uint8(uint160(addr) >> (8 * (19 - i))) & 0x0f];
        }
        return string(str);
    }
}
