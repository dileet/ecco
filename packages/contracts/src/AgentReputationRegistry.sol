// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

contract AgentReputationRegistry is ReentrancyGuard {
    struct Feedback {
        address client;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        uint256 timestamp;
        bool revoked;
        string responseURI;
        bytes32 responseHash;
    }

    IAgentIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => mapping(address => Feedback[])) private _feedbacks;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex
    );

    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI
    );

    constructor(address registry) {
        identityRegistry = IAgentIdentityRegistry(registry);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external nonReentrant {
        require(identityRegistry.ownerOf(agentId) != msg.sender, "Owner cannot give feedback");

        if (!_isClient[agentId][msg.sender]) {
            _clients[agentId].push(msg.sender);
            _isClient[agentId][msg.sender] = true;
        }

        _feedbacks[agentId][msg.sender].push(Feedback({
            client: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash,
            timestamp: block.timestamp,
            revoked: false,
            responseURI: "",
            responseHash: bytes32(0)
        }));

        uint64 index = uint64(_feedbacks[agentId][msg.sender].length - 1);
        emit NewFeedback(agentId, msg.sender, index, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external nonReentrant {
        Feedback[] storage feedbacks = _feedbacks[agentId][msg.sender];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");
        require(!feedbacks[feedbackIndex].revoked, "Already revoked");
        require(feedbacks[feedbackIndex].client == msg.sender, "Not feedback owner");

        feedbacks[feedbackIndex].revoked = true;

        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external nonReentrant {
        require(identityRegistry.ownerOf(agentId) == msg.sender, "Not agent owner");

        Feedback[] storage feedbacks = _feedbacks[agentId][clientAddress];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");
        require(!feedbacks[feedbackIndex].revoked, "Feedback revoked");

        feedbacks[feedbackIndex].responseURI = responseURI;
        feedbacks[feedbackIndex].responseHash = responseHash;

        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI);
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 averageValue, uint8 maxDecimals) {
        int256 totalValue = 0;
        uint256 totalCount = 0;
        uint8 maxDec = 0;

        address[] memory clients = _resolveClients(agentId, clientAddresses);

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (feedbacks[j].revoked) continue;

                if (!_matchesTag(feedbacks[j].tag1, tag1)) continue;
                if (!_matchesTag(feedbacks[j].tag2, tag2)) continue;

                if (feedbacks[j].valueDecimals > maxDec) {
                    maxDec = feedbacks[j].valueDecimals;
                }

                totalCount += 1;
            }
        }

        if (totalCount == 0) {
            return (0, 0, 0);
        }

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (feedbacks[j].revoked) continue;

                if (!_matchesTag(feedbacks[j].tag1, tag1)) continue;
                if (!_matchesTag(feedbacks[j].tag2, tag2)) continue;

                uint8 decimalDiff = maxDec - feedbacks[j].valueDecimals;
                int256 normalizedValue = int256(feedbacks[j].value) * int256(uint256(10 ** decimalDiff));
                totalValue += normalizedValue;
            }
        }

        return (uint64(totalCount), int128(totalValue / int256(totalCount)), maxDec);
    }

    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        bool isRevoked
    ) {
        Feedback[] storage feedbacks = _feedbacks[agentId][clientAddress];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");

        Feedback storage fb = feedbacks[feedbackIndex];
        return (fb.value, fb.valueDecimals, fb.tag1, fb.tag2, fb.revoked);
    }

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    ) external view returns (
        address[] memory clientAddressesOut,
        uint64[] memory feedbackIndexes,
        int128[] memory values,
        uint8[] memory valueDecimalsArr,
        string[] memory tag1s,
        string[] memory tag2s,
        bool[] memory revokedStatuses
    ) {
        address[] memory clients = _resolveClients(agentId, clientAddresses);

        uint256 maxCount = 0;
        for (uint256 i = 0; i < clients.length; i++) {
            maxCount += _feedbacks[agentId][clients[i]].length;
        }

        address[] memory tempClients = new address[](maxCount);
        uint64[] memory tempIndexes = new uint64[](maxCount);
        uint256 total = 0;

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (!includeRevoked && feedbacks[j].revoked) continue;
                if (!_matchesTag(feedbacks[j].tag1, tag1)) continue;
                if (!_matchesTag(feedbacks[j].tag2, tag2)) continue;
                tempClients[total] = clients[i];
                tempIndexes[total] = uint64(j);
                total += 1;
            }
        }

        clientAddressesOut = new address[](total);
        feedbackIndexes = new uint64[](total);
        values = new int128[](total);
        valueDecimalsArr = new uint8[](total);
        tag1s = new string[](total);
        tag2s = new string[](total);
        revokedStatuses = new bool[](total);

        for (uint256 i = 0; i < total; i++) {
            clientAddressesOut[i] = tempClients[i];
            feedbackIndexes[i] = tempIndexes[i];
            Feedback storage feedback = _feedbacks[agentId][tempClients[i]][tempIndexes[i]];
            values[i] = feedback.value;
            valueDecimalsArr[i] = feedback.valueDecimals;
            tag1s[i] = feedback.tag1;
            tag2s[i] = feedback.tag2;
            revokedStatuses[i] = feedback.revoked;
        }
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        uint256 length = _feedbacks[agentId][clientAddress].length;
        if (length == 0) {
            return 0;
        }
        return uint64(length - 1);
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    function getFeedbackCount(uint256 agentId) external view returns (uint256) {
        address[] storage clients = _clients[agentId];
        uint256 total = 0;
        for (uint256 i = 0; i < clients.length; i++) {
            total += _feedbacks[agentId][clients[i]].length;
        }
        return total;
    }

    function getAverageValue(uint256 agentId) external view returns (int128 averageValue, uint8 maxDecimals) {
        address[] storage clients = _clients[agentId];
        int256 totalValue = 0;
        uint256 totalCount = 0;
        uint8 maxDec = 0;

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (feedbacks[j].revoked) continue;
                if (feedbacks[j].valueDecimals > maxDec) {
                    maxDec = feedbacks[j].valueDecimals;
                }
                totalCount += 1;
            }
        }

        if (totalCount == 0) {
            return (0, 0);
        }

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (feedbacks[j].revoked) continue;
                uint8 decimalDiff = maxDec - feedbacks[j].valueDecimals;
                int256 normalizedValue = int256(feedbacks[j].value) * int256(uint256(10 ** decimalDiff));
                totalValue += normalizedValue;
            }
        }

        return (int128(totalValue / int256(totalCount)), maxDec);
    }

    function _matchesTag(string memory value, string memory filter) internal pure returns (bool) {
        if (bytes(filter).length == 0) {
            return true;
        }
        return keccak256(bytes(value)) == keccak256(bytes(filter));
    }

    function _resolveClients(uint256 agentId, address[] calldata clientAddresses) internal view returns (address[] memory) {
        if (clientAddresses.length == 0) {
            address[] storage storedClients = _clients[agentId];
            address[] memory clients = new address[](storedClients.length);
            for (uint256 i = 0; i < storedClients.length; i++) {
                clients[i] = storedClients[i];
            }
            return clients;
        }

        address[] memory provided = new address[](clientAddresses.length);
        for (uint256 i = 0; i < clientAddresses.length; i++) {
            provided[i] = clientAddresses[i];
        }
        return provided;
    }

}
