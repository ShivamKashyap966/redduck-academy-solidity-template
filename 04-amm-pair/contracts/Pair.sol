// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Constant-product AMM Pair
/// @notice A simplified constant-product (x * y = k) AMM pair folding core and router
///         into a single contract with a 0.3% swap fee and permanent minimum liquidity lock.
contract Pair is ERC20 {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address public constant DEAD_ADDRESS = address(0x000000000000000000000000000000000000dEaD);

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 private _locked = 1;

    error InsufficientLiquidity();
    error InsufficientAmount();
    error InsufficientOutput();
    error InvalidToken();

    event LiquidityAdded(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swapped(address indexed who, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IERC20 _token0, IERC20 _token1) ERC20("Simple AMM LP", "sLP") {
        token0 = _token0;
        token1 = _token1;
    }

    /// @notice Returns expected output amount given input and current reserves, charging a 0.3% fee.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;

        return numerator / denominator;
    }

    /// @notice Deposits token0 and token1 into the pool and mints proportional LP tokens to the caller.
    function addLiquidity(uint256 amount0, uint256 amount1) external nonReentrant returns (uint256 liquidity) {
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();

        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) {
            uint256 initialLiquidity = _sqrt(amount0 * amount1);
            if (initialLiquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();

            liquidity = initialLiquidity - MINIMUM_LIQUIDITY;
            _mint(DEAD_ADDRESS, MINIMUM_LIQUIDITY);
            _mint(msg.sender, liquidity);
        } else {
            uint256 liquidity0 = (amount0 * _totalSupply) / reserve0;
            uint256 liquidity1 = (amount1 * _totalSupply) / reserve1;
            liquidity = _min(liquidity0, liquidity1);

            if (liquidity == 0) revert InsufficientLiquidity();
            _mint(msg.sender, liquidity);
        }

        reserve0 += amount0;
        reserve1 += amount1;

        token0.transferFrom(msg.sender, address(this), amount0);
        token1.transferFrom(msg.sender, address(this), amount1);

        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity);
    }

    /// @notice Burns LP tokens from the caller and returns proportional shares of reserve0 and reserve1.
    function removeLiquidity(uint256 liquidity) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) revert InsufficientAmount();

        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) revert InsufficientLiquidity();

        amount0 = (liquidity * reserve0) / _totalSupply;
        amount1 = (liquidity * reserve1) / _totalSupply;

        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        _burn(msg.sender, liquidity);

        reserve0 -= amount0;
        reserve1 -= amount1;

        token0.transfer(msg.sender, amount0);
        token1.transfer(msg.sender, amount1);

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    /// @notice Swaps amountIn of tokenIn for the other token, requiring at least minAmountOut.
    function swap(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256 amountOut) {
        if (tokenIn != address(token0) && tokenIn != address(token1)) revert InvalidToken();

        bool isToken0 = tokenIn == address(token0);
        (uint256 reserveIn, uint256 reserveOut) = isToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
        IERC20 tokenOut = isToken0 ? token1 : token0;

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        if (isToken0) {
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        tokenOut.transfer(msg.sender, amountOut);

        emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
