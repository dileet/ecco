// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function getApproved(uint256 tokenId) external view returns (address);
}

contract AgentValidationRegistry is ReentrancyGuard {
    struct ValidationRequestData {
        address requester;
        address validator;
        uint256 agentId;
        string requestURI;
        bytes32 requestHash;
        uint256 timestamp;
        bool responded;
    }

    struct ValidationResponseData {
        uint8 response;
        string responseURI;
        bytes32 responseHash;
        string tag;
        uint256 timestamp;
    }

    IAgentIdentityRegistry public immutable identityRegistry;

    mapping(bytes32 => ValidationRequestData) private _requests;
    mapping(bytes32 => ValidationResponseData[]) private _responses;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash);
    event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag);

    constructor(address registry) {
        identityRegistry = IAgentIdentityRegistry(registry);
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external nonReentrant {
        require(validatorAddress != address(0), "Invalid validator");
        require(requestHash != bytes32(0), "Invalid request hash");

        address owner = identityRegistry.ownerOf(agentId);
        if (msg.sender != owner) {
            require(
                identityRegistry.isApprovedForAll(owner, msg.sender) ||
                    identityRegistry.getApproved(agentId) == msg.sender,
                "Not agent owner"
            );
        }

        if (_requests[requestHash].timestamp == 0) {
            _requests[requestHash] = ValidationRequestData({
                requester: msg.sender,
                validator: validatorAddress,
                agentId: agentId,
                requestURI: requestURI,
                requestHash: requestHash,
                timestamp: block.timestamp,
                responded: false
            });
            _agentValidations[agentId].push(requestHash);
            _validatorRequests[validatorAddress].push(requestHash);
        }

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external nonReentrant {
        ValidationRequestData storage request = _requests[requestHash];
        require(request.timestamp > 0, "Request not found");
        require(request.validator == msg.sender, "Not the designated validator");
        require(response <= 100, "Response must be 0-100");

        _responses[requestHash].push(ValidationResponseData({
            response: response,
            responseURI: responseURI,
            responseHash: responseHash,
            tag: tag,
            timestamp: block.timestamp
        }));

        request.responded = true;

        emit ValidationResponse(msg.sender, request.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash) external view returns (
        address validatorAddress,
        uint256 agentId,
        uint8 response,
        string memory tag,
        uint256 lastUpdate
    ) {
        ValidationRequestData storage request = _requests[requestHash];
        require(request.timestamp > 0, "Request not found");

        validatorAddress = request.validator;
        agentId = request.agentId;

        uint256 responseCount = _responses[requestHash].length;
        if (responseCount == 0) {
            return (validatorAddress, agentId, 0, "", request.timestamp);
        }

        ValidationResponseData storage latest = _responses[requestHash][responseCount - 1];
        return (validatorAddress, agentId, latest.response, latest.tag, latest.timestamp);
    }

    function getValidationRequest(bytes32 requestHash) external view returns (ValidationRequestData memory) {
        require(_requests[requestHash].timestamp > 0, "Request not found");
        return _requests[requestHash];
    }

    function getValidationResponse(bytes32 requestHash) external view returns (ValidationResponseData memory) {
        uint256 responseCount = _responses[requestHash].length;
        require(responseCount > 0, "Response not found");
        return _responses[requestHash][responseCount - 1];
    }

    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        bytes32[] storage requestHashes = _agentValidations[agentId];
        uint256 totalResponse = 0;
        uint256 totalCount = 0;

        for (uint256 i = 0; i < requestHashes.length; i++) {
        ValidationRequestData storage request = _requests[requestHashes[i]];
        uint256 responseCount = _responses[requestHashes[i]].length;

            if (responseCount == 0) continue;

            bool validatorMatch = validatorAddresses.length == 0;
            for (uint256 j = 0; j < validatorAddresses.length && !validatorMatch; j++) {
                if (request.validator == validatorAddresses[j]) {
                    validatorMatch = true;
                }
            }
            if (!validatorMatch) continue;

            ValidationResponseData storage latest = _responses[requestHashes[i]][responseCount - 1];
            if (bytes(tag).length > 0 && keccak256(bytes(latest.tag)) != keccak256(bytes(tag))) {
                continue;
            }

            totalResponse += latest.response;
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

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }
}
