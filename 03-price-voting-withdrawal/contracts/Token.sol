// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Academy Token
/// @notice A minimal ERC-20 token implemented from the ERC-20 specification.
contract Token is IERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZeroAddress();
    error ApproveToZeroAddress();

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;

        // Mint the full initial supply to whoever deploys the contract. The
        // zero address acts as the "minting" source, so wallets and explorers
        // recognize it as a creation of new tokens.
        _totalSupply = initialSupply;
        _balances[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();

        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        // The caller must have been granted enough allowance by `from`.
        uint256 currentAllowance = _allowances[from][msg.sender];
        if (currentAllowance < value) revert InsufficientAllowance();
        // Always consume the full `value`; a revert unwrites this if the
        // transfer below fails, so state stays consistent.
        _allowances[from][msg.sender] = currentAllowance - value;

        _transfer(from, to, value);
        return true;
    }

    /// @dev Shared move logic: validates the recipient and the sender's
    ///      balance, updates both balances, and emits Transfer.
    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert TransferToZeroAddress();

        uint256 fromBalance = _balances[from];
        if (fromBalance < value) revert InsufficientBalance();

        // Both subtractions/additions use Solidity 0.8 checked arithmetic.
        // `to`'s balance cannot overflow because the sum of all balances
        // always equals the fixed total supply.
        _balances[from] = fromBalance - value;
        _balances[to] += value;

        emit Transfer(from, to, value);
    }
}
