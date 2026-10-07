// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockStable
/// @notice A plain mintable ERC-20 standing in for a local stablecoin on Base Sepolia (EURCt: "Boundline test
///         EURC", 6 decimals). The owner mints; nothing else is special. The real EURC on Base mainnet is
///         Circle's FiatToken, which the payout router treats exactly the same way.
contract MockStable is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
