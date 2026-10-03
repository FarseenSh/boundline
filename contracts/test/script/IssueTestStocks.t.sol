// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {IssueTestStocks, TestStockLib} from "../../script/IssueTestStocks.s.sol";
import {PrecompileMocks} from "./PrecompileMocks.sol";

/// @dev Exposes the script's internal logic without broadcast; the precompiles see this contract
///      as msg.sender, so it plays the broadcaster/admin role.
contract IssueTestStocksHarness is IssueTestStocks {
    function issueFrom(string memory symbol, address[] memory extra, uint256 mintAmount, uint256 cap)
        external
        returns (Issued memory)
    {
        return _issue(address(this), symbol, extra, mintAmount, cap);
    }

    function wireFrom(address token, address[] memory venues) external returns (uint64, uint64) {
        return _wire(address(this), token, venues);
    }
}

contract IssueTestStocksTest is Test {
    IssueTestStocksHarness harness;
    address alice = makeAddr("alice");
    address stranger = makeAddr("stranger");
    address morpho = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address desk = makeAddr("desk");
    address keeper = makeAddr("keeper");

    /// @dev True under Base's Foundry build, where the real precompiles answer and cannot be
    ///      etched; false under stock forge, where base-std's mocks are etched instead. The same
    ///      flow runs in both worlds.
    bool livePrecompiles;

    function setUp() public {
        if (PrecompileMocks.present() || PrecompileMocks.factoryLive()) {
            livePrecompiles = true;
            PrecompileMocks.activateIfNeeded();
        } else if (PrecompileMocks.tryEtch()) {
            PrecompileMocks.activateIfNeeded();
        } else {
            // Base's Foundry build reserves the precompile addresses, so the mocks cannot be
            // etched, yet the precompiles are not live under this profile: nothing to test against.
            vm.skip(true);
            return;
        }
        harness = new IssueTestStocksHarness();
    }

    /// @dev `wire` needs Cobalt's composite policies. Base's Foundry build v1.1.0 runs Beryl
    ///      precompiles, where `createCompositePolicy` reverts with its own selector, so the
    ///      composite tests are skipped there (a `base-foundryup --install nightly` build or any
    ///      Cobalt chain runs them); the mocks and stock forge always run them.
    function _requireCompositePolicies() internal {
        if (!PrecompileMocks.compositePoliciesSupported()) vm.skip(true);
    }

    function _issue() internal returns (IssueTestStocks.Issued memory r) {
        address[] memory extra = new address[](1);
        extra[0] = alice;
        r = harness.issueFrom("AAPLt", extra, 1000e8, 1_000_000e8);
    }

    function test_initCalls_orderAndCount() public pure {
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = address(0xA11CE);
        amt[0] = 1e8;
        bytes[] memory calls = TestStockLib.initCalls(address(0xAD), 5e8, 7, 8, to, amt);
        // the bundle skips the zero burnBlocker, so 6 role grants, then seize, cap, 3 policies, mint
        assertEq(calls.length, 6 + 6, "6 role grants from the bundle, then seize, cap, 3 policies, mint");
        assertEq(bytes4(calls[0]), IB20.grantRole.selector);
        assertEq(bytes4(calls[6]), IB20.grantRole.selector); // SEIZE_ROLE
        assertEq(calls[6], abi.encodeCall(IB20.grantRole, (B20Constants.SEIZE_ROLE, address(0xAD))));
        assertEq(bytes4(calls[7]), IB20.updateSupplyCap.selector);
        assertEq(bytes4(calls[8]), IB20.updatePolicy.selector);
        assertEq(calls[8], abi.encodeCall(IB20.updatePolicy, (B20Constants.MINT_RECEIVER_POLICY, uint64(7))));
        assertEq(calls[10], abi.encodeCall(IB20.updatePolicy, (B20Constants.TRANSFER_RECEIVER_POLICY, uint64(8))));
        assertEq(bytes4(calls[11]), IB20Asset.batchMint.selector);
        assertEq(TestStockLib.salt("AAPLt"), keccak256("boundline/test-stock/AAPLt/v1"));
    }

    function test_issue_createsTokenAtPredictedAddressWithRolesPoliciesAndMint() public {
        IssueTestStocks.Issued memory r = _issue();
        assertEq(r.token, r.predicted, "predicted address");
        assertTrue(StdPrecompiles.B20_FACTORY.isB20Initialized(r.token));

        IB20Asset t = IB20Asset(r.token);
        assertEq(t.symbol(), "AAPLt");
        assertEq(t.name(), "Boundline test AAPLt");
        assertEq(t.decimals(), 8);
        assertEq(t.supplyCap(), 1_000_000e8);
        assertEq(t.balanceOf(address(harness)), 1000e8, "broadcaster minted");
        assertEq(t.balanceOf(alice), 1000e8, "MINT_TO minted");
        assertEq(t.totalSupply(), 2000e8);

        assertTrue(t.hasRole(B20Constants.DEFAULT_ADMIN_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.MINT_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.BURN_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.PAUSE_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.UNPAUSE_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.SEIZE_ROLE, address(harness)));
        assertTrue(t.hasRole(B20Constants.OPERATOR_ROLE, address(harness)));

        assertEq(t.policyId(B20Constants.MINT_RECEIVER_POLICY), r.holdersAllowlistId);
        assertEq(t.policyId(B20Constants.TRANSFER_SENDER_POLICY), r.blocklistId);
        assertEq(t.policyId(B20Constants.TRANSFER_RECEIVER_POLICY), r.blocklistId);
        assertEq(uint8(r.holdersAllowlistId >> 56), uint8(IPolicyRegistry.PolicyType.ALLOWLIST));
        assertEq(uint8(r.blocklistId >> 56), uint8(IPolicyRegistry.PolicyType.BLOCKLIST));

        // the empty blocklist lets anyone transact until wire() narrows receivers
        vm.prank(alice);
        assertTrue(t.transfer(stranger, 1e8));
    }

    function test_issue_isDeterministicAndRefusesASecondIssue() public {
        IssueTestStocks.Issued memory r = _issue();
        assertEq(
            r.token,
            StdPrecompiles.B20_FACTORY
                .getB20Address(IB20Factory.B20Variant.ASSET, address(harness), TestStockLib.salt("AAPLt"))
        );
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(IB20Factory.TokenAlreadyExists.selector, r.token));
        harness.issueFrom("AAPLt", none, 1e8, 1e9);
        // a different symbol is a different token
        IssueTestStocks.Issued memory n = harness.issueFrom("NVDAt", none, 1e8, 1e9);
        assertTrue(n.token != r.token);
    }

    function test_wire_bindsCompositeReceiverPolicyAndSeizeExempt() public {
        _requireCompositePolicies();
        IssueTestStocks.Issued memory r = _issue();
        address[] memory venues = new address[](3);
        venues[0] = morpho;
        venues[1] = desk;
        venues[2] = keeper;
        (uint64 compositeId, uint64 seizeExemptId) = harness.wireFrom(r.token, venues);

        IB20 t = IB20(r.token);
        IPolicyRegistry reg = StdPrecompiles.POLICY_REGISTRY;
        assertEq(t.policyId(B20Constants.TRANSFER_RECEIVER_POLICY), compositeId);
        assertEq(t.policyId(B20Constants.SEIZE_EXEMPT_POLICY), seizeExemptId);
        assertEq(uint8(compositeId >> 56), uint8(IPolicyRegistry.PolicyType.INTERSECT));
        uint64[] memory children = reg.compositePolicyChildIds(compositeId);
        assertEq(children.length, 2);
        assertEq(children[0], r.blocklistId);
        assertEq(children[1], r.holdersAllowlistId, "the holders allowlist from issue() is reused");

        // receivers: venues and existing holders yes, strangers no
        assertTrue(reg.isAuthorized(compositeId, morpho));
        assertTrue(reg.isAuthorized(compositeId, desk));
        assertTrue(reg.isAuthorized(compositeId, address(harness)));
        assertTrue(reg.isAuthorized(compositeId, alice));
        assertFalse(reg.isAuthorized(compositeId, stranger));
        // seize exempt: only the venues
        assertTrue(reg.isAuthorized(seizeExemptId, morpho));
        assertFalse(reg.isAuthorized(seizeExemptId, alice));

        vm.prank(alice);
        assertTrue(t.transfer(morpho, 1e8), "transfer to a venue");
        vm.prank(alice);
        vm.expectRevert();
        t.transfer(stranger, 1e8);
    }

    function test_wire_blocklistStillBlocksAHolder() public {
        _requireCompositePolicies();
        IssueTestStocks.Issued memory r = _issue();
        address[] memory venues = new address[](1);
        venues[0] = morpho;
        (uint64 compositeId,) = harness.wireFrom(r.token, venues);
        address[] memory blocked = new address[](1);
        blocked[0] = alice;
        vm.prank(address(harness));
        StdPrecompiles.POLICY_REGISTRY.updateBlocklist(r.blocklistId, true, blocked);
        assertFalse(StdPrecompiles.POLICY_REGISTRY.isAuthorized(compositeId, alice), "blocked beats allowlisted");
        vm.prank(alice);
        vm.expectRevert();
        IB20(r.token).transfer(morpho, 1e8);
    }

    function test_wire_onForeignTokenCreatesFreshPolicies() public {
        _requireCompositePolicies();
        // A token whose policies are the ALWAYS_ALLOW sentinel: wire must not try to compose id 0.
        IssueTestStocks.Issued memory r = _issue();
        vm.startPrank(address(harness));
        IB20(r.token).updatePolicy(B20Constants.MINT_RECEIVER_POLICY, 0);
        IB20(r.token).updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, 0);
        vm.stopPrank();
        address[] memory venues = new address[](1);
        venues[0] = morpho;
        (uint64 compositeId,) = harness.wireFrom(r.token, venues);
        uint64[] memory children = StdPrecompiles.POLICY_REGISTRY.compositePolicyChildIds(compositeId);
        assertTrue(children[0] != 0 && children[1] != 0);
        assertTrue(StdPrecompiles.POLICY_REGISTRY.isAuthorized(compositeId, morpho));
        assertTrue(StdPrecompiles.POLICY_REGISTRY.isAuthorized(compositeId, address(harness)));
    }
}
