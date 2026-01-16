// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

contract AgentReputationRegistry is ReentrancyGuard {
    struct Feedback {
        address client;
        uint8 score;
        bytes32 tag1;
        bytes32 tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        uint256 timestamp;
        bool revoked;
        string responseURI;
        bytes32 responseHash;
    }

    struct FeedbackEntry {
        address client;
        uint64 index;
        uint8 score;
        bytes32 tag1;
        bytes32 tag2;
        bool revoked;
    }

    IAgentIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => mapping(address => Feedback[])) private _feedbacks;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    mapping(uint256 => uint256) private _totalScore;
    mapping(uint256 => uint256) private _feedbackCount;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed client,
        uint64 feedbackIndex,
        uint8 score,
        bytes32 indexed tag1,
        bytes32 tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed client,
        uint64 indexed feedbackIndex
    );

    event ResponseAppended(
        uint256 indexed agentId,
        address indexed client,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI
    );

    constructor(address _identityRegistry) {
        identityRegistry = IAgentIdentityRegistry(_identityRegistry);
    }

    function giveFeedback(
        uint256 agentId,
        uint8 score,
        bytes32 tag1,
        bytes32 tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external nonReentrant {
        require(score <= 100, "Score must be 0-100");

        if (!_isClient[agentId][msg.sender]) {
            _clients[agentId].push(msg.sender);
            _isClient[agentId][msg.sender] = true;
        }

        _feedbacks[agentId][msg.sender].push(Feedback({
            client: msg.sender,
            score: score,
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

        _totalScore[agentId] += score;
        _feedbackCount[agentId] += 1;

        uint64 index = uint64(_feedbacks[agentId][msg.sender].length - 1);
        emit NewFeedback(agentId, msg.sender, index, score, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external nonReentrant {
        Feedback[] storage feedbacks = _feedbacks[agentId][msg.sender];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");
        require(!feedbacks[feedbackIndex].revoked, "Already revoked");
        require(feedbacks[feedbackIndex].client == msg.sender, "Not feedback owner");

        feedbacks[feedbackIndex].revoked = true;

        _totalScore[agentId] -= feedbacks[feedbackIndex].score;
        _feedbackCount[agentId] -= 1;

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
        bytes32 tag1,
        bytes32 tag2
    ) external view returns (uint64 count, uint8 averageScore) {
        uint256 totalScore = 0;
        uint256 totalCount = 0;

        address[] memory clients;
        if (clientAddresses.length > 0) {
            clients = clientAddresses;
        } else {
            clients = _clients[agentId];
        }

        for (uint256 i = 0; i < clients.length; i++) {
            Feedback[] storage feedbacks = _feedbacks[agentId][clients[i]];
            for (uint256 j = 0; j < feedbacks.length; j++) {
                if (feedbacks[j].revoked) continue;

                bool matchTag1 = tag1 == bytes32(0) || feedbacks[j].tag1 == tag1;
                bool matchTag2 = tag2 == bytes32(0) || feedbacks[j].tag2 == tag2;

                if (matchTag1 && matchTag2) {
                    totalScore += feedbacks[j].score;
                    totalCount += 1;
                }
            }
        }

        if (totalCount == 0) {
            return (0, 0);
        }

        return (uint64(totalCount), uint8(totalScore / totalCount));
    }

    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (
        uint8 score,
        bytes32 tag1,
        bytes32 tag2,
        bool isRevoked
    ) {
        Feedback[] storage feedbacks = _feedbacks[agentId][clientAddress];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");

        Feedback storage fb = feedbacks[feedbackIndex];
        return (fb.score, fb.tag1, fb.tag2, fb.revoked);
    }

    function readFullFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (Feedback memory) {
        Feedback[] storage feedbacks = _feedbacks[agentId][clientAddress];
        require(feedbackIndex < feedbacks.length, "Invalid feedback index");
        return feedbacks[feedbackIndex];
    }

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        bytes32 tag1,
        bytes32 tag2,
        bool includeRevoked
    ) external view returns (FeedbackEntry[] memory entries) {
        address[] memory allClients;
        if (clientAddresses.length > 0) {
            allClients = clientAddresses;
        } else {
            allClients = _clients[agentId];
        }

        uint256 totalItems = _countTotalFeedbacks(agentId, allClients);
        entries = new FeedbackEntry[](totalItems);

        uint256 resultIndex = 0;
        for (uint256 i = 0; i < allClients.length; i++) {
            resultIndex = _collectFeedbacks(
                agentId, allClients[i], tag1, tag2, includeRevoked, entries, resultIndex
            );
        }

        assembly {
            mstore(entries, resultIndex)
        }
    }

    function _countTotalFeedbacks(uint256 agentId, address[] memory clients) internal view returns (uint256 total) {
        for (uint256 i = 0; i < clients.length; i++) {
            total += _feedbacks[agentId][clients[i]].length;
        }
    }

    function _collectFeedbacks(
        uint256 agentId,
        address client,
        bytes32 tag1,
        bytes32 tag2,
        bool includeRevoked,
        FeedbackEntry[] memory entries,
        uint256 startIndex
    ) internal view returns (uint256 nextIndex) {
        Feedback[] storage feedbacks = _feedbacks[agentId][client];
        nextIndex = startIndex;

        for (uint256 j = 0; j < feedbacks.length; j++) {
            if (!includeRevoked && feedbacks[j].revoked) continue;
            if (tag1 != bytes32(0) && feedbacks[j].tag1 != tag1) continue;
            if (tag2 != bytes32(0) && feedbacks[j].tag2 != tag2) continue;

            entries[nextIndex] = FeedbackEntry({
                client: client,
                index: uint64(j),
                score: feedbacks[j].score,
                tag1: feedbacks[j].tag1,
                tag2: feedbacks[j].tag2,
                revoked: feedbacks[j].revoked
            });
            nextIndex++;
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

    function getFeedbackCount(uint256 agentId) external view returns (uint256) {
        return _feedbackCount[agentId];
    }

    function getAverageScore(uint256 agentId) external view returns (uint8) {
        if (_feedbackCount[agentId] == 0) {
            return 0;
        }
        return uint8(_totalScore[agentId] / _feedbackCount[agentId]);
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }
}
