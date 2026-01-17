// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract AgentIdentityRegistry is ERC721URIStorage, ERC721Enumerable, EIP712, Ownable {
    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return ERC721URIStorage.tokenURI(tokenId);
    }
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private _nextAgentId = 1;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(bytes32 => uint256) public peerIdHashToAgentId;

    string private constant AGENT_WALLET_KEY = "agentWallet";
    string private constant PEER_ID_HASH_KEY = "peerIdHash";
    bytes32 private constant AGENT_WALLET_KEY_HASH = keccak256(bytes(AGENT_WALLET_KEY));
    bytes32 private constant PEER_ID_HASH_KEY_HASH = keccak256(bytes(PEER_ID_HASH_KEY));
    bytes32 private constant AGENT_WALLET_TYPEHASH = keccak256("AgentWallet(uint256 agentId,address newWallet,uint256 deadline)");

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event PeerIdBound(uint256 indexed agentId, bytes32 indexed peerIdHash);

    constructor(address token, address owner) ERC721("Ecco Agent", "AGENT") EIP712("AgentIdentityRegistry", "1") Ownable(owner) {
        token;
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, agentURI);
        _applyMetadata(agentId, metadata);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function register() external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, "");
        emit Registered(agentId, "", msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function agentURI(uint256 agentId) external view returns (string memory) {
        return tokenURI(agentId);
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        _requireOwned(agentId);
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        _setMetadataInternal(agentId, metadataKey, metadataValue);
    }

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Signature expired");
        require(newWallet != address(0), "Invalid new wallet");

        address owner = ownerOf(agentId);
        bytes32 structHash = keccak256(abi.encode(
            AGENT_WALLET_TYPEHASH,
            agentId,
            newWallet,
            deadline
        ));
        bytes32 digest = _hashTypedDataV4(structHash);

        if (owner.code.length > 0) {
            bytes4 result = IERC1271(owner).isValidSignature(digest, signature);
            require(result == IERC1271.isValidSignature.selector, "Invalid signature");
        } else {
            address signer = ECDSA.recover(digest, signature);
            require(signer == owner, "Invalid signature");
        }

        _setAgentWalletMetadata(agentId, newWallet);
    }

    function getGlobalId(uint256 agentId) external view returns (string memory) {
        _requireOwned(agentId);
        return string(abi.encodePacked(
            "eip155:",
            Strings.toString(block.chainid),
            ":",
            Strings.toHexString(address(this))
        ));
    }

    function getAgentByPeerIdHash(bytes32 peerIdHash) external view returns (uint256) {
        return peerIdHashToAgentId[peerIdHash];
    }

    function bindPeerId(uint256 agentId, string calldata peerId) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");

        bytes memory peerIdBytes = bytes(peerId);
        bytes32 peerIdHash = keccak256(peerIdBytes);

        _metadata[agentId]["peerId"] = peerIdBytes;
        emit MetadataSet(agentId, "peerId", "peerId", peerIdBytes);

        bytes32 oldHash = bytes32(_metadata[agentId][PEER_ID_HASH_KEY]);
        if (oldHash != bytes32(0)) {
            delete peerIdHashToAgentId[oldHash];
        }

        require(
            peerIdHashToAgentId[peerIdHash] == 0 || peerIdHashToAgentId[peerIdHash] == agentId,
            "PeerId already bound"
        );

        peerIdHashToAgentId[peerIdHash] = agentId;
        _metadata[agentId][PEER_ID_HASH_KEY] = abi.encodePacked(peerIdHash);

        emit MetadataSet(agentId, PEER_ID_HASH_KEY, PEER_ID_HASH_KEY, abi.encodePacked(peerIdHash));
        emit PeerIdBound(agentId, peerIdHash);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable, ERC721)
        returns (address)
    {
        address previousOwner = super._update(to, tokenId, auth);
        if (previousOwner != address(0) && to != address(0) && previousOwner != to) {
            _setAgentWalletMetadata(tokenId, address(0));
        }
        return previousOwner;
    }

    function _mintAgent(address owner, string memory agentURI) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _safeMint(owner, agentId);
        _setTokenURI(agentId, agentURI);
    }

    function _applyMetadata(uint256 agentId, MetadataEntry[] calldata metadata) internal {
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadataInternal(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _setMetadataInternal(uint256 agentId, string memory metadataKey, bytes memory metadataValue) internal {
        if (keccak256(bytes(metadataKey)) == AGENT_WALLET_KEY_HASH) {
            revert("Reserved key");
        }

        if (keccak256(bytes(metadataKey)) == PEER_ID_HASH_KEY_HASH) {
            bytes32 oldHash = bytes32(_metadata[agentId][metadataKey]);
            if (oldHash != bytes32(0)) {
                delete peerIdHashToAgentId[oldHash];
            }

            bytes32 newHash = bytes32(metadataValue);
            if (newHash != bytes32(0)) {
                require(
                    peerIdHashToAgentId[newHash] == 0 || peerIdHashToAgentId[newHash] == agentId,
                    "PeerId already bound"
                );
                peerIdHashToAgentId[newHash] = agentId;
                emit PeerIdBound(agentId, newHash);
            }
        }

        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function _setAgentWalletMetadata(uint256 agentId, address wallet) internal {
        bytes memory value = abi.encodePacked(wallet);
        _metadata[agentId][AGENT_WALLET_KEY] = value;
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, value);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }
}
