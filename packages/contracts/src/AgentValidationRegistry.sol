// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

contract AgentValidationRegistry is ReentrancyGuard {
    struct ValidationRequest {
        address requester;
        address validator;
        uint256 agentId;
        string requestURI;
        bytes32 requestHash;
        uint256 timestamp;
        bool responded;
    }

    struct ValidationResponse {
        uint8 response;
        string responseURI;
        bytes32 responseHash;
        bytes32 tag;
        uint256 timestamp;
    }

    IAgentIdentityRegistry public immutable identityRegistry;

    mapping(bytes32 => ValidationRequest) private _requests;
    mapping(bytes32 => ValidationResponse) private _responses;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    mapping(uint256 => mapping(address => uint256)) private _validatorResponseCount;
    mapping(uint256 => mapping(address => uint256)) private _validatorResponseTotal;

    event ValidationRequested(
        bytes32 indexed requestHash,
        address indexed requester,
        address indexed validator,
        uint256 agentId,
        string requestURI
    );

    event ValidationResponded(
        bytes32 indexed requestHash,
        address indexed validator,
        uint256 indexed agentId,
        uint8 response,
        bytes32 tag,
        string responseURI
    );

    constructor(address _identityRegistry) {
        identityRegistry = IAgentIdentityRegistry(_identityRegistry);
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external nonReentrant returns (bytes32 requestId) {
        require(validatorAddress != address(0), "Invalid validator");

        requestId = keccak256(abi.encodePacked(
            msg.sender,
            validatorAddress,
            agentId,
            requestHash,
            block.timestamp
        ));

        require(_requests[requestId].timestamp == 0, "Request already exists");

        _requests[requestId] = ValidationRequest({
            requester: msg.sender,
            validator: validatorAddress,
            agentId: agentId,
            requestURI: requestURI,
            requestHash: requestHash,
            timestamp: block.timestamp,
            responded: false
        });

        _agentValidations[agentId].push(requestId);
        _validatorRequests[validatorAddress].push(requestId);

        emit ValidationRequested(requestId, msg.sender, validatorAddress, agentId, requestURI);
    }

    function validationResponse(
        bytes32 requestId,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        bytes32 tag
    ) external nonReentrant {
        ValidationRequest storage request = _requests[requestId];
        require(request.timestamp > 0, "Request not found");
        require(request.validator == msg.sender, "Not the designated validator");
        require(!request.responded, "Already responded");

        request.responded = true;

        _responses[requestId] = ValidationResponse({
            response: response,
            responseURI: responseURI,
            responseHash: responseHash,
            tag: tag,
            timestamp: block.timestamp
        });

        _validatorResponseCount[request.agentId][msg.sender] += 1;
        _validatorResponseTotal[request.agentId][msg.sender] += response;

        emit ValidationResponded(requestId, msg.sender, request.agentId, response, tag, responseURI);
    }

    function getValidationStatus(bytes32 requestId) external view returns (
        address validatorAddress,
        uint256 agentId,
        uint8 response,
        bytes32 tag,
        uint256 lastUpdate
    ) {
        ValidationRequest storage request = _requests[requestId];
        require(request.timestamp > 0, "Request not found");

        ValidationResponse storage resp = _responses[requestId];

        return (
            request.validator,
            request.agentId,
            resp.response,
            resp.tag,
            resp.timestamp > 0 ? resp.timestamp : request.timestamp
        );
    }

    function getValidationRequest(bytes32 requestId) external view returns (ValidationRequest memory) {
        require(_requests[requestId].timestamp > 0, "Request not found");
        return _requests[requestId];
    }

    function getValidationResponse(bytes32 requestId) external view returns (ValidationResponse memory) {
        require(_requests[requestId].timestamp > 0, "Request not found");
        return _responses[requestId];
    }

    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        bytes32 tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        bytes32[] storage requestIds = _agentValidations[agentId];

        uint256 totalResponse = 0;
        uint256 totalCount = 0;

        for (uint256 i = 0; i < requestIds.length; i++) {
            bytes32 requestId = requestIds[i];
            ValidationRequest storage request = _requests[requestId];

            if (!request.responded) continue;

            bool validatorMatch = validatorAddresses.length == 0;
            for (uint256 j = 0; j < validatorAddresses.length && !validatorMatch; j++) {
                if (request.validator == validatorAddresses[j]) {
                    validatorMatch = true;
                }
            }
            if (!validatorMatch) continue;

            ValidationResponse storage resp = _responses[requestId];
            if (tag != bytes32(0) && resp.tag != tag) continue;

            totalResponse += resp.response;
            totalCount += 1;
        }

        if (totalCount == 0) {
            return (0, 0);
        }

        return (uint64(totalCount), uint8(totalResponse / totalCount));
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function getPendingRequests(address validatorAddress) external view returns (bytes32[] memory) {
        bytes32[] storage allRequests = _validatorRequests[validatorAddress];

        uint256 pendingCount = 0;
        for (uint256 i = 0; i < allRequests.length; i++) {
            if (!_requests[allRequests[i]].responded) {
                pendingCount++;
            }
        }

        bytes32[] memory pending = new bytes32[](pendingCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allRequests.length; i++) {
            if (!_requests[allRequests[i]].responded) {
                pending[index] = allRequests[i];
                index++;
            }
        }

        return pending;
    }

    function getValidatorStats(
        uint256 agentId,
        address validatorAddress
    ) external view returns (uint256 responseCount, uint8 averageResponse) {
        uint256 count = _validatorResponseCount[agentId][validatorAddress];
        if (count == 0) {
            return (0, 0);
        }
        uint256 total = _validatorResponseTotal[agentId][validatorAddress];
        return (count, uint8(total / count));
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }
}
