// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

contract EccoConstitution is Ownable {
    string[] private _items;
    uint256[] private _itemIds;
    uint256 private _nextItemId;
    mapping(bytes32 => bool) private _contentExists;

    event ItemAdded(uint256 indexed itemId, string content);
    event ItemRemoved(uint256 indexed itemId, string content);
    event ItemMoved(uint256 indexed itemId, uint256 indexed toIndex);

    constructor(string[] memory initialItems, address initialOwner) Ownable(initialOwner) {
        for (uint256 i = 0; i < initialItems.length; i++) {
            _addItem(initialItems[i]);
        }
    }

    function addItem(string calldata content) external onlyOwner returns (uint256) {
        return _addItem(content);
    }

    function removeItem(uint256 index) external onlyOwner {
        require(index < _items.length, "Invalid index");

        string memory content = _items[index];
        uint256 removedItemId = _itemIds[index];
        bytes32 contentHash = keccak256(bytes(content));

        _contentExists[contentHash] = false;

        uint256 lastIndex = _items.length - 1;
        if (index != lastIndex) {
            _items[index] = _items[lastIndex];
            _itemIds[index] = _itemIds[lastIndex];
            emit ItemMoved(_itemIds[index], index);
        }
        _items.pop();
        _itemIds.pop();

        emit ItemRemoved(removedItemId, content);
    }

    function getItem(uint256 index) external view returns (string memory) {
        require(index < _items.length, "Invalid index");
        return _items[index];
    }

    function getItemId(uint256 index) external view returns (uint256) {
        require(index < _items.length, "Invalid index");
        return _itemIds[index];
    }

    function getItemCount() external view returns (uint256) {
        return _items.length;
    }

    function getAllItems() external view returns (string[] memory) {
        return _items;
    }

    function getAllItemIds() external view returns (uint256[] memory) {
        return _itemIds;
    }

    function contentExists(string calldata content) external view returns (bool) {
        return _contentExists[keccak256(bytes(content))];
    }

    function _addItem(string memory content) private returns (uint256) {
        require(bytes(content).length > 0, "Empty content");
        bytes32 contentHash = keccak256(bytes(content));
        require(!_contentExists[contentHash], "Duplicate content");

        uint256 itemId = _nextItemId++;
        _items.push(content);
        _itemIds.push(itemId);
        _contentExists[contentHash] = true;

        emit ItemAdded(itemId, content);
        return itemId;
    }
}
