// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockIdentityRegistry is ERC721 {
    uint256 private _nextTokenId;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => string) private _tokenURIs;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);

    constructor() ERC721("MockAgent", "MAGENT") {}

    function register(string memory agentURI) external returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);
        _tokenURIs[tokenId] = agentURI;
        emit Registered(tokenId, agentURI, msg.sender);
        return tokenId;
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        require(ownerOf(agentId) == msg.sender, "Not owner");
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return _tokenURIs[tokenId];
    }
}
