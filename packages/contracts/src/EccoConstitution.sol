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

    function getItemsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory) {
        if (offset >= _items.length) {
            return new string[](0);
        }
        uint256 remaining = _items.length - offset;
        uint256 count = limit < remaining ? limit : remaining;
        string[] memory result = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _items[offset + i];
        }
        return result;
    }

    function getItemIdsPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        if (offset >= _itemIds.length) {
            return new uint256[](0);
        }
        uint256 remaining = _itemIds.length - offset;
        uint256 count = limit < remaining ? limit : remaining;
        uint256[] memory result = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _itemIds[offset + i];
        }
        return result;
    }

    function contentExists(string calldata content) external view returns (bool) {
        return _contentExists[keccak256(bytes(content))];
    }

    function renounceOwnership() public override {
        revert("Renunciation disabled");
    }

    function _addItem(string memory content) private returns (uint256) {
        require(_hasVisibleContent(bytes(content)), "Empty content");
        bytes32 contentHash = keccak256(bytes(content));
        require(!_contentExists[contentHash], "Duplicate content");

        uint256 itemId = _nextItemId++;
        _items.push(content);
        _itemIds.push(itemId);
        _contentExists[contentHash] = true;

        emit ItemAdded(itemId, content);
        return itemId;
    }

    function _hasVisibleContent(bytes memory data) private pure returns (bool) {
        if (data.length == 0) return false;
        for (uint256 i = 0; i < data.length; i++) {
            bytes1 b = data[i];
            if (b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D || b == 0x0B || b == 0x0C) {
                continue;
            }
            if (b == 0xC2 && i + 1 < data.length && data[i + 1] == 0xA0) {
                i += 1;
                continue;
            }
            if (b == 0xE2 && i + 2 < data.length) {
                if (data[i + 1] == 0x80) {
                    bytes1 third = data[i + 2];
                    if (
                        third == 0x8B || third == 0x8C || third == 0x8D ||
                        third == 0x8E || third == 0x8F || third == 0xAA ||
                        third == 0xAB || third == 0xAC || third == 0xAD || third == 0xAE
                    ) {
                        i += 2;
                        continue;
                    }
                }
                if (data[i + 1] == 0x81 && data[i + 2] == 0xA0) {
                    i += 2;
                    continue;
                }
            }
            if (b == 0xEF && i + 2 < data.length && data[i + 1] == 0xBB && data[i + 2] == 0xBF) {
                i += 2;
                continue;
            }
            return true;
        }
        return false;
    }
}
