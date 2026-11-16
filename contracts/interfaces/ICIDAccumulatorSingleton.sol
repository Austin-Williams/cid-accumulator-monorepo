// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface ICIDAccumulatorSingleton {
    /// @notice Returns the packed MMR metadata bits and peaks for any account.
    function getState(
        address account
    ) external view returns (uint256, bytes32[32] memory);

    /// @notice Appends a single leaf to the Merkle Mountain Range.
    /// @param payload Raw data block to append.
    function appendLeaf(bytes calldata payload) external;

    /// @notice Appends leaves from `payloadArr` to the Merkle Mountain Range.
    /// @param payloadArr Array of raw data blocks to append.
    /// @dev This function is gas-optimized for payloadArr.length > 1.
    /// @dev It uses a cache-aside buffer for on-demand peaks loads, which is only more gas efficient for payloadArr.length > 1.
    /// @dev For payloadArr.length == 1, use `appendLeaf` for better gas efficiency.
    function appendLeaves(bytes[] calldata payloadArr) external;

    /// @notice Computes and returns the raw CIDv1 byte sequence for any account’s MMR root.
    function getRootCID(
        address account
    ) external view returns (bytes memory rawCIDv1);

    /// @notice Returns the Base32-encoded CID string for any account’s MMR root.
    function getRootCIDString(
        address account
    ) external view returns (string memory);

    /// @notice Returns the packed MMR metadata bits for any account.
    function getMMRMetaBits(address account) external view returns (uint256);
}
