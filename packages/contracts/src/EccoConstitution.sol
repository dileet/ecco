// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

contract EccoConstitution is Ownable {
    string[] private _items;
    mapping(bytes32 => bool) private _contentExists;

    event ItemAdded(uint256 indexed index, string content);
    event ItemRemoved(uint256 indexed index, string content);
    event ItemMoved(uint256 indexed fromIndex, uint256 indexed toIndex, string content);

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
        bytes32 contentHash = keccak256(bytes(content));

        _contentExists[contentHash] = false;

        uint256 lastIndex = _items.length - 1;
        if (index != lastIndex) {
            string memory movedContent = _items[lastIndex];
            _items[index] = movedContent;
            emit ItemMoved(lastIndex, index, movedContent);
        }
        _items.pop();

        emit ItemRemoved(index, content);
    }

    function getItem(uint256 index) external view returns (string memory) {
        require(index < _items.length, "Invalid index");
        return _items[index];
    }

    function getItemCount() external view returns (uint256) {
        return _items.length;
    }

    function getAllItems() external view returns (string[] memory) {
        return _items;
    }

    function contentExists(string calldata content) external view returns (bool) {
        return _contentExists[keccak256(bytes(content))];
    }

    function _addItem(string memory content) private returns (uint256) {
        require(bytes(content).length > 0, "Empty content");
        bytes32 contentHash = keccak256(bytes(content));
        require(!_contentExists[contentHash], "Duplicate content");

        uint256 index = _items.length;
        _items.push(content);
        _contentExists[contentHash] = true;

        emit ItemAdded(index, content);
        return index;
    }
}
