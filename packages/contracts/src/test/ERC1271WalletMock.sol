// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract ERC1271WalletMock is IERC1271 {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    bytes32 private _validHash;

    function setValidHash(bytes32 newHash) external {
        _validHash = newHash;
    }

    function isValidSignature(bytes32 hash, bytes memory) external view returns (bytes4) {
        if (hash == _validHash || _validHash == bytes32(0)) {
            return MAGICVALUE;
        }
        return 0xffffffff;
    }
}
