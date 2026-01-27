// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockIdentityRegistry is ERC721 {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private _nextTokenId;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => address) private _agentWallets;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    constructor() ERC721("MockAgent", "MAGENT") {}

    function register() external returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);
        emit Registered(tokenId, "", msg.sender);
        emit MetadataSet(tokenId, "agentWallet", "agentWallet", abi.encode(msg.sender));
        return tokenId;
    }

    function register(string memory agentURI) external returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);
        _tokenURIs[tokenId] = agentURI;
        emit Registered(tokenId, agentURI, msg.sender);
        emit MetadataSet(tokenId, "agentWallet", "agentWallet", abi.encode(msg.sender));
        return tokenId;
    }

    function register(string memory agentURI, MetadataEntry[] memory entries) external returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);
        _tokenURIs[tokenId] = agentURI;
        for (uint256 i = 0; i < entries.length; i++) {
            require(
                keccak256(bytes(entries[i].metadataKey)) != keccak256(bytes("agentWallet")),
                "Reserved key: agentWallet"
            );
            _metadata[tokenId][entries[i].metadataKey] = entries[i].metadataValue;
            emit MetadataSet(tokenId, entries[i].metadataKey, entries[i].metadataKey, entries[i].metadataValue);
        }
        emit Registered(tokenId, agentURI, msg.sender);
        emit MetadataSet(tokenId, "agentWallet", "agentWallet", abi.encode(msg.sender));
        return tokenId;
    }

    function setAgentURI(uint256 agentId, string memory agentURI) external {
        require(ownerOf(agentId) == msg.sender, "Not owner");
        _tokenURIs[agentId] = agentURI;
        emit URIUpdated(agentId, agentURI, msg.sender);
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        require(ownerOf(agentId) == msg.sender, "Not owner");
        require(
            keccak256(bytes(metadataKey)) != keccak256(bytes("agentWallet")),
            "Reserved key: agentWallet"
        );
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        require(ownerOf(agentId) == msg.sender, "Not owner");
        _agentWallets[agentId] = wallet;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallets[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external {
        require(ownerOf(agentId) == msg.sender, "Not owner");
        delete _agentWallets[agentId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return _tokenURIs[tokenId];
    }
}
